import { normalizeAndValidateUrl } from "./url-policy";
import { parseFeed } from "./feed-parser";
import { parseSitemap } from "./sitemap-parser";
import { extractHtmlListLinks } from "./html-extractor";
import { enqueueCandidates, type EnqueueResult, type PendingBudget } from "./pending-repository";
import { checkWriteGate, completeWriteReservation, D1_STORAGE_STOP_BYTES } from "./storage-guard";
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
  if (candidate.terminalFailure !== undefined) {
    bound.terminalFailure = candidate.terminalFailure;
    return bound;
  }
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
): Promise<{ reset: boolean; storageLimit: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const reservation = await checkWriteGate(db, "pending", 1024);
  if (reservation === "storage_limit") return { reset: false, storageLimit: true };

  let sizeAfter = reservation.measuredSize;
  try {
    const result = await db.prepare(
      `UPDATE sources SET ${column} = NULL, updated_at = ? WHERE id = ? AND ${column} = ? RETURNING id`,
    ).bind(now, sourceId, expectedValue).run<{ id: string }>();
    sizeAfter = result.meta.size_after;
    return {
      reset: (result.results?.length ?? 0) > 0,
      storageLimit: sizeAfter >= D1_STORAGE_STOP_BYTES,
    };
  } finally {
    await completeWriteReservation(db, reservation.id, sizeAfter, now);
  }
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
      const reset = parsed.cursorFound && source.feed_watermark !== null
        ? await resetCursor(db, source.id, "feed_watermark", source.feed_watermark)
        : { reset: false, storageLimit: false };
      return {
        ...fallbackResult(parsed.cursorFound, reset.storageLimit && !reset.reset, reset.storageLimit ? "storage_limit" : null),
        cursorReset: reset.reset,
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
    const childCursor = budget.pendingSitemapId === undefined ? null : budget.pendingSitemapCursor ?? null;
    const savedCursor = budget.pendingSitemapId === undefined
      ? source.sitemap_last_loc ?? undefined
      : childCursor ?? undefined;
    const cursorIndex = savedCursor === undefined
      ? -1
      : parsed.locations.findIndex((location) => location.sourceCursor.value === savedCursor);
    const cursorFound = savedCursor === undefined || cursorIndex >= 0;
    const startIndex = savedCursor === undefined || cursorIndex < 0 ? 0 : cursorIndex + 1;
    const remaining = parsed.locations.slice(startIndex);
    if (remaining.length === 0) {
      const reset = budget.pendingSitemapId === undefined && cursorFound && source.sitemap_last_loc !== null
        ? await resetCursor(db, source.id, "sitemap_last_loc", source.sitemap_last_loc)
        : { reset: false, storageLimit: false };
      return {
        ...fallbackResult(cursorFound, reset.storageLimit && !reset.reset, reset.storageLimit ? "storage_limit" : null),
        cursorReset: reset.reset,
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
      terminalFailure: location.terminalFailure,
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

export async function discoverHtmlList(
  db: D1Database,
  source: Source,
  body: string,
  budget: PendingBudget = {},
  listUrl = source.url,
): Promise<DiscoveryResult> {
  if (!source.enabled || source.kind !== "html_list" || source.selectors?.itemLink === undefined) {
    return fallbackResult(true, false, "unsupported_source");
  }

  const candidates = await extractHtmlListLinks(body, listUrl, source.selectors.itemLink);
  const savedCursor = source.feed_watermark ?? undefined;
  const cursorIndex = savedCursor === undefined
    ? -1
    : candidates.findIndex((candidate) => candidate.sourceCursor?.value === savedCursor);
  const cursorFound = savedCursor === undefined || cursorIndex >= 0;
  const startIndex = savedCursor === undefined || cursorIndex < 0 ? 0 : cursorIndex + 1;
  const remaining = candidates.slice(startIndex);
  if (remaining.length === 0) {
    const reset = cursorFound && source.feed_watermark !== null
      ? await resetCursor(db, source.id, "feed_watermark", source.feed_watermark)
      : { reset: false, storageLimit: false };
    return {
      ...fallbackResult(cursorFound, reset.storageLimit && !reset.reset, reset.storageLimit ? "storage_limit" : null),
      cursorReset: reset.reset,
    };
  }

  const page = remaining.slice(0, MAX_DISCOVERY_CANDIDATES);
  const articleCandidates = page.map((candidate) => markHostMismatch(candidate, source, "article"));
  const stored = await enqueueCandidates(db, source, articleCandidates, budget);
  return {
    ...stored,
    enqueued: stored.inserted,
    cursorFound,
    cursorReset: false,
    blocked: stored.blocked,
    hasMore: stored.hasMore || remaining.length > page.length,
  };
}
