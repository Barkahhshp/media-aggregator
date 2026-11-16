import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Candidate, SourceCursor } from "../src/ingest/types";
import type { Source } from "../src/sources/types";

interface PendingBudget {
  maxCandidates?: number;
  maxTotalRows?: number;
  maxSerializedBytes?: number;
}

interface EnqueueResult {
  inserted: number;
  deduplicated: number;
  failed: number;
  lastAccountedCursor: SourceCursor | null;
  hasMore: boolean;
  stopReason: string | null;
}

interface PendingItem {
  id: string;
  source_id: string;
  item_type: "article" | "sitemap";
  dedupe_key: string;
  external_id: string | null;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  published_at: string | null;
  status: "pending" | "leased" | "retry_wait" | "blocked" | "failed";
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  terminal_expires_at: number | null;
  discovered_at: number;
}

type PendingFailure =
  | { kind: "retryable"; nextAttemptAt: number; code: string; message: string }
  | { kind: "terminal"; status: "blocked" | "failed"; now: number; code: string; message: string };

interface PendingRepositoryModule {
  enqueueCandidates(db: D1Database, source: Source, candidates: Candidate[], budget: PendingBudget): Promise<EnqueueResult>;
  claimPending(db: D1Database, now: number, leaseToken: string): Promise<PendingItem | null>;
  markPendingFailure(db: D1Database, item: PendingItem, outcome: PendingFailure): Promise<void>;
  purgeExpiredTerminalItems(db: D1Database, now: number): Promise<number>;
}

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestBindings;
const repositoryModules = import.meta.glob<PendingRepositoryModule>("../src/ingest/pending-repository.ts");

async function loadRepository() {
  const moduleLoader = repositoryModules["../src/ingest/pending-repository.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.enqueueCandidates).toBeTypeOf("function");
  expect(module.claimPending).toBeTypeOf("function");
  expect(module.markPendingFailure).toBeTypeOf("function");
  expect(module.purgeExpiredTerminalItems).toBeTypeOf("function");
  return module;
}

async function makeSource(): Promise<Source> {
  const now = Math.floor(Date.now() / 1000);
  const source: Source = {
    id: crypto.randomUUID(),
    kind: "feed",
    url: "https://example.com/rss.xml",
    host: "example.com",
    poll_interval_sec: 7200,
    selectors: null,
    enabled: true,
    next_fetch_at: now,
    etag: null,
    last_modified: null,
    feed_watermark: null,
    sitemap_last_loc: null,
    consecutive_errors: 0,
    last_status: null,
    last_fetched_at: null,
    created_at: now,
    updated_at: now,
  };
  await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, ?, ?)")
    .bind(source.id, source.url, source.kind, source.host)
    .run();
  return source;
}

function makeCandidate(index: number, overrides: Partial<Candidate> = {}): Candidate {
  const externalId = `story-${index}`;
  return {
    sourceId: "untrusted-caller-source",
    dedupeKey: externalId,
    canonicalUrl: `https://example.com/story-${index}`,
    externalId,
    title: `Story ${index}`,
    summary: null,
    author: null,
    publishedAt: null,
    sourceCursor: { kind: "feed", value: externalId },
    ...overrides,
  };
}

async function pendingRows(): Promise<PendingItem[]> {
  const result = await testEnv.DB.prepare("SELECT * FROM pending_items ORDER BY discovered_at, id").all<PendingItem>();
  return result.results;
}

async function feedWatermark(sourceId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare("SELECT feed_watermark FROM sources WHERE id = ?").bind(sourceId).first<{ feed_watermark: string | null }>();
  return row?.feed_watermark ?? null;
}

async function sourceLastStatus(sourceId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare("SELECT last_status FROM sources WHERE id = ?").bind(sourceId).first<{ last_status: string | null }>();
  return row?.last_status ?? null;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("durable pending repository", () => {
  it("persists_at_most_ten_candidates_and_advances_only_to_the_tenth", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    const candidates = Array.from({ length: 15 }, (_, index) => makeCandidate(index));

    const result = await repository.enqueueCandidates(testEnv.DB, source, candidates, {});

    expect(result.inserted).toBe(10);
    expect(result.lastAccountedCursor).toEqual({ kind: "feed", value: "story-9" });
    expect(await feedWatermark(source.id)).toBe("story-9");
    expect(await pendingRows()).toHaveLength(10);
    expect((await pendingRows()).every((row) => row.source_id === source.id)).toBe(true);
  });

  it("advances_over_an_existing_dedupe_even_when_new_rows_cannot_fit", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    const alreadyStored = makeCandidate(0);
    await repository.enqueueCandidates(testEnv.DB, source, [alreadyStored], {});
    await testEnv.DB.prepare("UPDATE sources SET feed_watermark = NULL WHERE id = ?").bind(source.id).run();

    const result = await repository.enqueueCandidates(
      testEnv.DB,
      { ...source, feed_watermark: null },
      [alreadyStored, makeCandidate(1)],
      { maxTotalRows: 1 },
    );

    expect(result.inserted).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(result.lastAccountedCursor).toEqual({ kind: "feed", value: "story-0" });
    expect(await feedWatermark(source.id)).toBe("story-0");
    expect(await pendingRows()).toHaveLength(1);
  });

  it("continues_accounting_for_dedupes_after_the_new_row_budget_is_used", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    const alreadyStored = makeCandidate(7);
    await repository.enqueueCandidates(testEnv.DB, source, [alreadyStored], {});
    await testEnv.DB.prepare("UPDATE sources SET feed_watermark = NULL WHERE id = ?").bind(source.id).run();

    const result = await repository.enqueueCandidates(
      testEnv.DB,
      { ...source, feed_watermark: null },
      [makeCandidate(0), alreadyStored, makeCandidate(2)],
      { maxCandidates: 1 },
    );

    expect(result.inserted).toBe(1);
    expect(result.deduplicated).toBe(1);
    expect(result.lastAccountedCursor).toEqual({ kind: "feed", value: "story-7" });
    expect(result.hasMore).toBe(true);
    expect(await feedWatermark(source.id)).toBe("story-7");
    expect((await pendingRows()).map((row) => row.dedupe_key).sort()).toEqual(["story-0", "story-7"]);
  });

  it("does_not_advance_past_the_first_candidate_that_exceeds_pending_row_capacity", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(
      testEnv.DB,
      source,
      [makeCandidate(0), makeCandidate(1), makeCandidate(2)],
      { maxTotalRows: 2 },
    );

    expect(result.inserted).toBe(2);
    expect(result.lastAccountedCursor).toEqual({ kind: "feed", value: "story-1" });
    expect(await feedWatermark(source.id)).toBe("story-1");
    expect((await pendingRows()).map((row) => row.dedupe_key).sort()).toEqual(["story-0", "story-1"]);
  });

  it("does_not_persist_or_advance_when_a_candidate_cursor_does_not_match_its_dedupe_identity", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(testEnv.DB, source, [
      makeCandidate(0, { sourceCursor: { kind: "feed", value: "unrelated-cursor" } }),
    ], {});

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("invalid_cursor");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(0);
    expect(await feedWatermark(source.id)).toBeNull();
  });

  it.each([
    { field: "title", candidate: makeCandidate(1, { title: "x".repeat(4097) }) },
    { field: "summary", candidate: makeCandidate(2, { summary: "é".repeat(513) }) },
    { field: "external_id", candidate: makeCandidate(3, {
      externalId: "é".repeat(513),
      dedupeKey: "é".repeat(513),
      sourceCursor: { kind: "feed", value: "é".repeat(513) },
    }) },
    { field: "dedupe_key", candidate: makeCandidate(4, {
      externalId: null,
      dedupeKey: `https://example.com/${"x".repeat(4100)}`,
      canonicalUrl: `https://example.com/${"x".repeat(4100)}`,
      sourceCursor: { kind: "feed", value: "__cue_cursor_sha256_v1__:2e36c3782cf5a17a23eb090342d4c37c7193489b93bbdcd966ad83b553b19ed8" },
    }) },
    { field: "canonical_url", candidate: makeCandidate(6, { canonicalUrl: `https://example.com/${"x".repeat(4100)}` }) },
    { field: "published_at", candidate: makeCandidate(5, { publishedAt: "x".repeat(65) }) },
  ])("records_bounded_terminal_metadata_too_large_for_$field", async ({ field, candidate }) => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(testEnv.DB, source, [candidate], {});

    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.lastAccountedCursor).toEqual(candidate.sourceCursor);
    expect(await feedWatermark(source.id)).toBe(candidate.sourceCursor?.value ?? null);
    const row = (await pendingRows())[0];
    expect(row).toMatchObject({ status: "failed" });
    expect(row.last_error).toContain("metadata_too_large");
    expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBeLessThan(10_000);
    if (field === "title") expect(row.title).toBeNull();
    if (field === "summary") expect(row.summary).toBeNull();
    if (field === "external_id") expect(row.external_id).toBeNull();
    if (field === "published_at") expect(row.published_at).toBeNull();
    if (field === "dedupe_key") expect(row.dedupe_key).toMatch(/^__cue_pending_sha256_v1__:[a-f0-9]{64}$/);
    if (field === "canonical_url") expect(row.canonical_url).not.toContain("x".repeat(100));
  });

  it("enforces_the_serialized_pending_metadata_budget", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], { maxSerializedBytes: 1 });

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("metadata_limit");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(0);
    expect(await sourceLastStatus(source.id)).toBe("storage_limit");
  });

  it("stops_at_the_global_two_thousand_pending_row_cap", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await testEnv.DB.prepare(`
      WITH RECURSIVE tens(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM tens WHERE value < 49
      ), ones(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM ones WHERE value < 39
      )
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status)
      SELECT 'seed-' || (tens.value * 40 + ones.value), ?, 'article',
             'seed-' || (tens.value * 40 + ones.value),
             'https://example.com/seed/' || (tens.value * 40 + ones.value), 'pending'
      FROM tens CROSS JOIN ones
    `).bind(source.id).run();

    const result = await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("pending_limit");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(2000);
    expect(await feedWatermark(source.id)).toBeNull();
    expect(await sourceLastStatus(source.id)).toBe("storage_limit");
  });

  it("claims_the_oldest_eligible_pending_item_and_sets_a_reclaimable_lease", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(1), makeCandidate(2)], {});
    await testEnv.DB.prepare("UPDATE pending_items SET discovered_at = CASE dedupe_key WHEN 'story-1' THEN 10 ELSE 20 END WHERE source_id = ?")
      .bind(source.id)
      .run();
    const now = Math.floor(Date.now() / 1000) + 10;

    const firstClaim = await repository.claimPending(testEnv.DB, now, "lease-first");
    expect(firstClaim?.dedupe_key).toBe("story-1");
    expect(firstClaim).toMatchObject({ status: "leased", lease_token: "lease-first" });
    expect(firstClaim?.lease_expires_at).toBeGreaterThan(now);

    const reclaimed = await repository.claimPending(testEnv.DB, firstClaim?.lease_expires_at ?? now, "lease-reclaim");
    expect(reclaimed?.id).toBe(firstClaim?.id);
    expect(reclaimed).toMatchObject({ status: "leased", lease_token: "lease-reclaim" });
  });

  it("keeps_retryable_failures_and_releases_them_at_the_requested_time", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});
    const now = Math.floor(Date.now() / 1000) + 10;
    const item = await repository.claimPending(testEnv.DB, now, "lease-retry");
    if (!item) throw new Error("Expected a pending item to claim");

    await repository.markPendingFailure(testEnv.DB, item, {
      kind: "retryable",
      nextAttemptAt: now + 300,
      code: "temporary_fetch_error",
      message: "temporary upstream failure",
    });

    const saved = (await pendingRows())[0];
    expect(saved).toMatchObject({ status: "retry_wait", attempts: 1, next_attempt_at: now + 300, lease_token: null, lease_expires_at: null });
    expect(await repository.claimPending(testEnv.DB, now + 299, "too-early")).toBeNull();
    expect((await repository.claimPending(testEnv.DB, now + 300, "due-again"))?.dedupe_key).toBe("story-0");
  });

  it("retains_terminal_failures_for_thirty_days_then_purges_them", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});
    const now = Math.floor(Date.now() / 1000) + 10;
    const item = await repository.claimPending(testEnv.DB, now, "lease-terminal");
    if (!item) throw new Error("Expected a pending item to claim");

    await repository.markPendingFailure(testEnv.DB, item, {
      kind: "terminal",
      status: "blocked",
      now,
      code: "blocked_external_host",
      message: "blocked by source policy",
    });
    const terminal = (await pendingRows())[0];
    const expiresAt = now + 30 * 24 * 60 * 60;
    expect(terminal).toMatchObject({ status: "blocked", terminal_expires_at: expiresAt, lease_token: null, lease_expires_at: null });
    expect(await repository.purgeExpiredTerminalItems(testEnv.DB, expiresAt - 1)).toBe(0);
    expect(await repository.purgeExpiredTerminalItems(testEnv.DB, expiresAt)).toBe(1);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("bounds_terminal_error_text_by_UTF8_bytes", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});
    const now = Math.floor(Date.now() / 1000) + 10;
    const item = await repository.claimPending(testEnv.DB, now, "lease-long-error");
    if (!item) throw new Error("Expected a pending item to claim");

    await repository.markPendingFailure(testEnv.DB, item, {
      kind: "terminal",
      status: "failed",
      now,
      code: "upstream_error",
      message: "é".repeat(700),
    });

    const row = (await pendingRows())[0];
    expect(new TextEncoder().encode(row.last_error ?? "").byteLength).toBeLessThanOrEqual(1024);
    expect(row.status).toBe("failed");
  });
});
