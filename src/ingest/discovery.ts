import { normalizeAndValidateUrl } from "./url-policy";
import { parseFeed } from "./feed-parser";
import { parseSitemap } from "./sitemap-parser";
import { enqueueCandidates, type EnqueueResult, type PendingBudget } from "./pending-repository";
import type { Candidate } from "./types";
import type { Source } from "../sources/types";

export const MAX_DISCOVERY_CANDIDATES = 100;

export interface DiscoveryResult extends EnqueueResult {
  enqueued: number;
  cursorFound: boolean;
  cursorReset: boolean;
  blocked: number;
}

interface DiscoveryCandidate extends Candidate {
  pendingType?: "article" | "sitemap";
  terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
}

function canonicalHost(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.toLowerCase().replace(/\.$/u, "");
}

function markHostMismatch(candidate: Candidate, source: Source, pendingType: "article" | "sitemap"): DiscoveryCandidate {
  const bound: DiscoveryCandidate = { ...candidate, sourceId: source.id, pendingType };
  try {
    const parsed = normalizeAndValidateUrl(candidate.canonicalUrl);
    if (canonicalHost(parsed.hostname) !== canonicalHost(source.host)) {
      bound.terminalFailure = {
        status: "blocked",
        code: "blocked_external_host",
        message: "Candidate URL host differs from its source host",
      };
    }
  } catch {
    bound.terminalFailure = {
      status: "blocked",
      code: "blocked_unsafe_url",
      message: "Candidate URL is not a permitted public URL",
    };
  }
  return bound;
}

async function resetCursor(
  db: D1Database,
  sourceId: string,
  column: "feed_watermark" | "sitemap_last_loc",
  expectedValue: string,
): Promise<boolean> {
  const row = await db.prepare(
    `UPDATE sources SET ${column} = NULL, updated_at = ? WHERE id = ? AND ${column} = ? RETURNING id`,
  ).bind(Math.floor(Date.now() / 1000), sourceId, expectedValue).first<{ id: string }>();
  return row !== null;
}

function fallbackResult(cursorFound: boolean, hasMore: boolean, stopReason: EnqueueResult["stopReason"]): DiscoveryResult {
  return {
    inserted: 0,
    deduplicated: 0,
    failed: 0,
    blocked: 0,
    lastAccountedCursor: null,
    hasMore,
    stopReason,
    enqueued: 0,
    cursorFound,
    cursorReset: false,
  };
}

export async function discoverSource(
  db: D1Database,
  source: Source,
  body: string,
  contentType: string,
  budget: PendingBudget = {},
): Promise<DiscoveryResult> {
  if (!source.enabled) return fallbackResult(true, false, "unsupported_source");

  if (source.kind === "feed") {
    const afterCursor = source.feed_watermark === null
      ? undefined
      : { kind: "feed" as const, value: source.feed_watermark };
    const parsed = parseFeed(body, contentType, afterCursor);
    if (parsed.candidates.length === 0) {
      const cursorReset = parsed.cursorFound && source.feed_watermark !== null
        ? await resetCursor(db, source.id, "feed_watermark", source.feed_watermark)
        : false;
      return {
        ...fallbackResult(parsed.cursorFound, false, null),
        cursorReset,
      };
    }

    const candidates = parsed.candidates.slice(0, MAX_DISCOVERY_CANDIDATES)
      .map((candidate) => markHostMismatch(candidate, source, "article"));
    const stored = await enqueueCandidates(db, source, candidates, budget);
    const parserHasMore = parsed.hasMore || parsed.candidates.length > candidates.length;
    return {
      ...stored,
      enqueued: stored.inserted,
      cursorFound: parsed.cursorFound,
      cursorReset: false,
      blocked: stored.blocked,
      hasMore: stored.hasMore || parserHasMore,
    };
  }

  if (source.kind === "sitemap") {
    const parsed = parseSitemap(body);
    const savedCursor = source.sitemap_last_loc ?? undefined;
    const cursorIndex = savedCursor === undefined
      ? -1
      : parsed.locations.findIndex((location) => location.sourceCursor.value === savedCursor);
    const cursorFound = savedCursor === undefined || cursorIndex >= 0;
    const startIndex = savedCursor === undefined || cursorIndex < 0 ? 0 : cursorIndex + 1;
    const remaining = parsed.locations.slice(startIndex);
    if (remaining.length === 0) {
      const cursorReset = cursorFound && source.sitemap_last_loc !== null
        ? await resetCursor(db, source.id, "sitemap_last_loc", source.sitemap_last_loc)
        : false;
      return {
        ...fallbackResult(cursorFound, false, null),
        cursorReset,
      };
    }

    const page = remaining.slice(0, MAX_DISCOVERY_CANDIDATES);
    const candidates = page.map((location): DiscoveryCandidate => markHostMismatch({
      sourceId: source.id,
      dedupeKey: location.url,
      canonicalUrl: location.url,
      externalId: null,
      title: null,
      summary: null,
      author: null,
      publishedAt: location.lastModified,
      sourceCursor: location.sourceCursor,
    }, source, parsed.isIndex ? "sitemap" : "article"));
    const stored = await enqueueCandidates(db, source, candidates, budget);
    return {
      ...stored,
      enqueued: stored.inserted,
      cursorFound,
      cursorReset: false,
      blocked: stored.blocked,
      hasMore: stored.hasMore || remaining.length > page.length,
    };
  }

  return fallbackResult(true, false, "unsupported_source");
}
