import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Candidate, SourceCursor } from "../src/ingest/types";
import type { Source } from "../src/sources/types";

interface PendingBudget {
  now?: number;
  maxCandidates?: number;
  maxChecks?: number;
  maxTotalRows?: number;
  maxSerializedBytes?: number;
  pendingSitemapId?: string;
  pendingSitemapLeaseToken?: string;
  pendingSitemapCursor?: string | null;
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

interface StorageStateRow {
  observed_db_size: number;
  reserved_db_bytes: number;
  storage_state: "normal" | "storage_limit" | "read_only";
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

async function makeSource(kind: Source["kind"] = "feed"): Promise<Source> {
  const now = Math.floor(Date.now() / 1000);
  const source: Source = {
    id: crypto.randomUUID(),
    kind,
    url: `https://example.com/${kind === "feed" ? "rss.xml" : "article"}`,
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

async function storageState(): Promise<StorageStateRow> {
  const row = await testEnv.DB.prepare("SELECT observed_db_size, reserved_db_bytes, storage_state FROM system_state WHERE singleton_id = 'global'")
    .first<StorageStateRow>();
  if (!row) throw new Error("Expected global storage state to exist");
  return row;
}

function countedDatabase(db: D1Database): { db: D1Database; batchCalls: () => number } {
  let batchCalls = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: wrapped, batchCalls: () => batchCalls };
}

function withMeasuredSize(db: D1Database, measuredSize: number): D1Database {
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          return results.map((result) => ({ ...result, meta: { ...result.meta, size_after: measuredSize } }));
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              if (statementProperty === "run" && typeof value === "function") {
                return async <T = unknown>(): Promise<D1Result<T>> => {
                  const result = await statementTarget.run<T>();
                  if (query.includes("write_gate_probe")) {
                    return { ...result, meta: { ...result.meta, size_after: measuredSize } } as D1Result<T>;
                  }
                  return result;
                };
              }
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return wrapped;
}

function withPendingBatchSize(db: D1Database, measuredSize: number): D1Database {
  let batchNumber = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchNumber += 1;
          const results = await target.batch(statements);
          if (batchNumber !== 2) return results;
          return results.map((result) => ({ ...result, meta: { ...result.meta, size_after: measuredSize } }));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return wrapped;
}

function withProgressivePendingSize(db: D1Database, initialSize: number, growthPerInsert: number): { db: D1Database; measuredSize(): number } {
  let batchNumber = 0;
  let inserts = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchNumber += 1;
          const results = await target.batch(statements);
          if (batchNumber >= 2 && batchNumber <= 11) inserts += 1;
          const size = initialSize + inserts * growthPerInsert;
          return results.map((result) => ({ ...result, meta: { ...result.meta, size_after: size } }));
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              if (statementProperty === "run" && typeof value === "function") {
                return async <T = unknown>(): Promise<D1Result<T>> => {
                  const result = await statementTarget.run<T>();
                  return query.includes("write_gate_probe")
                    ? { ...result, meta: { ...result.meta, size_after: initialSize + inserts * growthPerInsert } } as D1Result<T>
                    : result;
                };
              }
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: wrapped, measuredSize: () => initialSize + inserts * growthPerInsert };
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

  it("deduplicates_and_queues_direct_article_candidates_without_a_feed_cursor", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource("article");
    const direct = makeCandidate(0, {
      externalId: null,
      dedupeKey: source.url,
      canonicalUrl: source.url,
      sourceCursor: null,
    });

    const first = await repository.enqueueCandidates(testEnv.DB, source, [direct], {});
    const second = await repository.enqueueCandidates(testEnv.DB, source, [direct], {});

    expect(first.inserted).toBe(1);
    expect(first.stopReason).toBeNull();
    expect(first.lastAccountedCursor).toBeNull();
    expect(second.inserted).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect(second.stopReason).toBeNull();
    expect(await pendingRows()).toHaveLength(1);
    expect(await feedWatermark(source.id)).toBeNull();
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

  it("bounds_D1_queries_to_50_when_duplicate_candidates_are_accounted_and_resumes_safely", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await testEnv.DB.prepare(`
      WITH RECURSIVE items(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM items WHERE value < 59
      )
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status)
      SELECT 'existing-' || value, ?, 'article', 'story-' || value,
             'https://example.com/story-' || value, 'pending'
      FROM items
    `).bind(source.id).run();
    const candidates = Array.from({ length: 60 }, (_, index) => makeCandidate(index));
    const firstCount = countedDatabase(testEnv.DB);

    const first = await repository.enqueueCandidates(firstCount.db, source, candidates, {});

    expect(firstCount.batchCalls()).toBeLessThanOrEqual(50);
    expect(first.deduplicated).toBe(25);
    expect(first.hasMore).toBe(true);
    expect(first.stopReason).toBe("query_limit");
    expect(first.lastAccountedCursor).toEqual({ kind: "feed", value: "story-24" });
    expect(await feedWatermark(source.id)).toBe("story-24");

    const secondCount = countedDatabase(testEnv.DB);
    const second = await repository.enqueueCandidates(secondCount.db, {
      ...source,
      feed_watermark: "story-24",
    }, candidates.slice(25), {});
    const third = await repository.enqueueCandidates(testEnv.DB, {
      ...source,
      feed_watermark: "story-49",
    }, candidates.slice(50), {});

    expect(secondCount.batchCalls()).toBeLessThanOrEqual(50);
    expect(second.deduplicated).toBe(25);
    expect(second.hasMore).toBe(true);
    expect(second.lastAccountedCursor).toEqual({ kind: "feed", value: "story-49" });
    expect(third.deduplicated).toBe(10);
    expect(third.hasMore).toBe(false);
    expect(await feedWatermark(source.id)).toBe("story-59");
  });

  it("records_the_physical_size_observation_after_indexed_pending_writes", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(88)], {});
    const state = await storageState();
    const measured = await testEnv.DB.prepare("SELECT 1 AS physical_size_probe").run();

    expect(result.inserted).toBe(1);
    expect(state.observed_db_size).toBeGreaterThanOrEqual(measured.meta.size_after);
    expect(state.reserved_db_bytes).toBe(0);
    expect(state.storage_state).toBe("normal");
  });

  it("marks_storage_limit_when_a_pending_batch_reports_280_MiB_in_meta_size_after", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(withPendingBatchSize(testEnv.DB, 280 * 1024 * 1024), source, [makeCandidate(0), makeCandidate(1)], {});

    expect(result.inserted).toBe(1);
    expect(result.stopReason).toBe("storage_limit");
    expect(result.hasMore).toBe(true);
    expect(result.lastAccountedCursor).toEqual({ kind: "feed", value: "story-0" });
    expect((await pendingRows()).map((row) => row.dedupe_key)).toEqual(["story-0"]);
    expect(await feedWatermark(source.id)).toBe("story-0");
    expect(await storageState()).toMatchObject({ observed_db_size: 280 * 1024 * 1024, storage_state: "storage_limit" });
  });

  it("stops_before_pending_or_cursor_writes_when_measured_size_reaches_280_MiB", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(withMeasuredSize(testEnv.DB, 280 * 1024 * 1024), source, [makeCandidate(0)], {});

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("storage_limit");
    expect(result.hasMore).toBe(true);
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(0);
    expect(await feedWatermark(source.id)).toBeNull();
    expect(await storageState()).toMatchObject({ observed_db_size: 280 * 1024 * 1024, reserved_db_bytes: 0, storage_state: "storage_limit" });
  });

  it("reserves_estimated_growth_before_writing_near_the_280_MiB_stop", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    const candidates = Array.from({ length: 35 }, (_, index) => makeCandidate(index));

    const justBelowStop = 280 * 1024 * 1024 - 1;
    const result = await repository.enqueueCandidates(withMeasuredSize(testEnv.DB, justBelowStop), source, candidates, {});

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("storage_limit");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(0);
    expect(await feedWatermark(source.id)).toBeNull();
    expect(await storageState()).toMatchObject({ observed_db_size: justBelowStop, reserved_db_bytes: 0, storage_state: "storage_limit" });
  });

  it("stops_sustained_overload_below_300_MiB_without_advancing_past_an_unpersisted_cursor", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    const candidates = Array.from({ length: 20 }, (_, index) => makeCandidate(index));
    const initialSize = 270 * 1024 * 1024;
    const growthPerInsert = 1024 * 1024;
    const firstRunDb = withProgressivePendingSize(testEnv.DB, initialSize, growthPerInsert);

    const first = await repository.enqueueCandidates(firstRunDb.db, source, candidates.slice(0, 10), {
      maxCandidates: 10,
      maxChecks: 10,
    });
    const watermarkAfterFirst = await feedWatermark(source.id);
    const second = await repository.enqueueCandidates(withMeasuredSize(testEnv.DB, 280 * 1024 * 1024), source, candidates.slice(10), {
      maxCandidates: 10,
      maxChecks: 10,
    });
    const state = await storageState();

    expect(first.inserted).toBe(10);
    expect(first.stopReason).toBe("storage_limit");
    expect(first.lastAccountedCursor).toEqual({ kind: "feed", value: "story-9" });
    expect(watermarkAfterFirst).toBe("story-9");
    expect(second.inserted).toBe(0);
    expect(second.stopReason).toBe("storage_limit");
    expect(second.lastAccountedCursor).toBeNull();
    expect(await feedWatermark(source.id)).toBe("story-9");
    expect((await pendingRows()).map((row) => row.dedupe_key).sort()).toEqual(candidates.slice(0, 10).map((item) => item.dedupeKey).sort());
    expect(state.observed_db_size).toBe(280 * 1024 * 1024);
    expect(state.observed_db_size).toBeLessThan(300 * 1024 * 1024);
    expect(state.reserved_db_bytes).toBe(0);
  });

  it("enters_read_only_without_pending_or_cursor_writes_at_the_300_MiB_hard_cap", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();

    const result = await repository.enqueueCandidates(withMeasuredSize(testEnv.DB, 300 * 1024 * 1024), source, [makeCandidate(0)], {});

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("storage_limit");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await pendingRows()).toHaveLength(0);
    expect(await feedWatermark(source.id)).toBeNull();
    expect(await storageState()).toMatchObject({ observed_db_size: 300 * 1024 * 1024, reserved_db_bytes: 0, storage_state: "read_only" });
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

  it("does_not_exceed_the_metadata_cap_when_advancing_a_child_sitemap_cursor", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource("sitemap");
    const now = Math.floor(Date.now() / 1000);
    const childId = crypto.randomUUID();
    const childLease = crypto.randomUUID();
    const childUrl = "https://example.com/child.xml";
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, lease_token, lease_expires_at)
      VALUES (?, ?, 'sitemap', ?, ?, 'leased', ?, ?)
    `).bind(childId, source.id, childUrl, childUrl, childLease, now + 120).run();
    const existing = await testEnv.DB.prepare(`
      SELECT COALESCE(SUM(length(CAST(json_object(
        'source_id', source_id, 'dedupe_key', dedupe_key, 'external_id', external_id,
        'canonical_url', canonical_url, 'title', title, 'summary', summary,
        'published_at', published_at, 'sitemap_cursor', sitemap_cursor, 'last_error', last_error
      ) AS BLOB))), 0) AS bytes FROM pending_items
    `).first<{ bytes: number }>();
    const next = makeCandidate(42, { sourceCursor: { kind: "sitemap", value: "story-42" } });
    const candidateBytes = new TextEncoder().encode(JSON.stringify({
      source_id: source.id,
      dedupe_key: next.dedupeKey,
      external_id: next.externalId,
      canonical_url: next.canonicalUrl,
      title: next.title,
      summary: next.summary,
      published_at: next.publishedAt,
      last_error: null,
    })).byteLength;

    const result = await repository.enqueueCandidates(testEnv.DB, source, [next], {
      now,
      maxSerializedBytes: (existing?.bytes ?? 0) + candidateBytes,
      pendingSitemapId: childId,
      pendingSitemapLeaseToken: childLease,
      pendingSitemapCursor: null,
    });

    expect(result.inserted).toBe(0);
    expect(result.stopReason).toBe("metadata_limit");
    expect(result.lastAccountedCursor).toBeNull();
    expect(await testEnv.DB.prepare("SELECT sitemap_cursor FROM pending_items WHERE id = ?").bind(childId).first())
      .toMatchObject({ sitemap_cursor: null });
    expect(await testEnv.DB.prepare("SELECT id FROM pending_items WHERE dedupe_key = ?").bind(next.dedupeKey).first()).toBeNull();
  });

  it("accounts_for_each_replacement_from_the_current_child_sitemap_cursor", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource("sitemap");
    const now = Math.floor(Date.now() / 1000);
    const childId = crypto.randomUUID();
    const childLease = crypto.randomUUID();
    const childUrl = "https://example.com/child.xml";
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, lease_token, lease_expires_at)
      VALUES (?, ?, 'sitemap', ?, ?, 'leased', ?, ?)
    `).bind(childId, source.id, childUrl, childUrl, childLease, now + 120).run();
    const existing = await testEnv.DB.prepare(`
      SELECT COALESCE(SUM(length(CAST(json_object(
        'source_id', source_id, 'dedupe_key', dedupe_key, 'external_id', external_id,
        'canonical_url', canonical_url, 'title', title, 'summary', summary,
        'published_at', published_at, 'sitemap_cursor', sitemap_cursor, 'last_error', last_error
      ) AS BLOB))), 0) AS bytes FROM pending_items
    `).first<{ bytes: number }>();
    const candidates = [
      makeCandidate(1, { dedupeKey: "a", externalId: null, sourceCursor: { kind: "sitemap", value: "a" } }),
      makeCandidate(2, {
        dedupeKey: `b${"x".repeat(100)}`,
        externalId: null,
        sourceCursor: { kind: "sitemap", value: `b${"x".repeat(100)}` },
      }),
    ];
    const serializedCandidateBytes = candidates.reduce((total, candidate) => total + new TextEncoder().encode(JSON.stringify({
      source_id: source.id,
      dedupe_key: candidate.dedupeKey,
      external_id: candidate.externalId,
      canonical_url: candidate.canonicalUrl,
      title: candidate.title,
      summary: candidate.summary,
      published_at: candidate.publishedAt,
      sitemap_cursor: null,
      last_error: null,
    })).byteLength, 0);
    const finalCursorBytesDelta = new TextEncoder().encode(JSON.stringify(candidates[1]?.sourceCursor?.value)).byteLength
      - new TextEncoder().encode(JSON.stringify(null)).byteLength;
    const maxSerializedBytes = (existing?.bytes ?? 0) + serializedCandidateBytes + finalCursorBytesDelta;

    const result = await repository.enqueueCandidates(testEnv.DB, source, candidates, {
      now,
      maxChecks: 2,
      maxCandidates: 2,
      maxSerializedBytes,
      pendingSitemapId: childId,
      pendingSitemapLeaseToken: childLease,
      pendingSitemapCursor: null,
    });
    const after = await testEnv.DB.prepare(`
      SELECT COALESCE(SUM(length(CAST(json_object(
        'source_id', source_id, 'dedupe_key', dedupe_key, 'external_id', external_id,
        'canonical_url', canonical_url, 'title', title, 'summary', summary,
        'published_at', published_at, 'sitemap_cursor', sitemap_cursor, 'last_error', last_error
      ) AS BLOB))), 0) AS bytes FROM pending_items
    `).first<{ bytes: number }>();

    expect(result.inserted).toBe(2);
    expect(await testEnv.DB.prepare("SELECT sitemap_cursor FROM pending_items WHERE id = ?").bind(childId).first())
      .toMatchObject({ sitemap_cursor: candidates[1]?.sourceCursor?.value });
    expect(after?.bytes).toBeLessThanOrEqual(maxSerializedBytes);
  });

  it("holds_a_child_cursor_when_a_duplicate_advance_would_exceed_the_metadata_cap", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource("sitemap");
    const now = Math.floor(Date.now() / 1000);
    const childId = crypto.randomUUID();
    const childLease = crypto.randomUUID();
    const childUrl = "https://example.com/child.xml";
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, lease_token, lease_expires_at)
      VALUES (?, ?, 'sitemap', ?, ?, 'leased', ?, ?)
    `).bind(childId, source.id, childUrl, childUrl, childLease, now + 120).run();
    const candidates = [
      makeCandidate(1, { dedupeKey: "a", externalId: null, sourceCursor: { kind: "sitemap", value: "a" } }),
      makeCandidate(2, {
        dedupeKey: `b${"x".repeat(100)}`,
        externalId: null,
        sourceCursor: { kind: "sitemap", value: `b${"x".repeat(100)}` },
      }),
    ];
    for (const [index, candidate] of candidates.entries()) {
      await testEnv.DB.prepare(`
        INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, title, status)
        VALUES (?, ?, 'article', ?, ?, ?, 'pending')
      `).bind(`already-${index}`, source.id, candidate.dedupeKey, candidate.canonicalUrl, candidate.title).run();
    }
    const current = await testEnv.DB.prepare(`
      SELECT COALESCE(SUM(length(CAST(json_object(
        'source_id', source_id, 'dedupe_key', dedupe_key, 'external_id', external_id,
        'canonical_url', canonical_url, 'title', title, 'summary', summary,
        'published_at', published_at, 'sitemap_cursor', sitemap_cursor, 'last_error', last_error
      ) AS BLOB))), 0) AS bytes FROM pending_items
    `).first<{ bytes: number }>();
    const cursorGrowth = new TextEncoder().encode(JSON.stringify(candidates[1]?.sourceCursor?.value)).byteLength
      - new TextEncoder().encode(JSON.stringify(null)).byteLength;
    const maxSerializedBytes = (current?.bytes ?? 0) + cursorGrowth - 1;

    const result = await repository.enqueueCandidates(testEnv.DB, source, candidates, {
      now,
      maxChecks: 2,
      maxCandidates: 2,
      maxSerializedBytes,
      pendingSitemapId: childId,
      pendingSitemapLeaseToken: childLease,
      pendingSitemapCursor: null,
    });
    const cursor = await testEnv.DB.prepare("SELECT sitemap_cursor FROM pending_items WHERE id = ?").bind(childId).first<{ sitemap_cursor: string | null }>();

    expect(result.deduplicated).toBe(1);
    expect(result.stopReason).toBe("metadata_limit");
    expect(result.lastAccountedCursor).toEqual({ kind: "sitemap", value: "a" });
    expect(cursor?.sitemap_cursor).toBe("a");
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

  it("does_not_claim_pending_backlog_for_a_disabled_source", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(70)], {});
    await testEnv.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();

    const claimed = await repository.claimPending(testEnv.DB, Math.floor(Date.now() / 1000) + 10, "disabled-source-lease");

    expect(claimed).toBeNull();
    expect(await testEnv.DB.prepare("SELECT status, attempts, lease_token FROM pending_items WHERE source_id = ?")
      .bind(source.id).first()).toEqual({ status: "pending", attempts: 0, lease_token: null });
  });

  it("does_not_claim_pending_items_when_the_storage_write_gate_is_closed", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();

    const claimed = await repository.claimPending(testEnv.DB, Math.floor(Date.now() / 1000) + 10, "denied-lease");

    expect(claimed).toBeNull();
    expect(await pendingRows()).toMatchObject([{ status: "pending", lease_token: null, attempts: 0 }]);
    expect(await storageState()).toMatchObject({ storage_state: "storage_limit", reserved_db_bytes: 0 });
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

  it("does_not_record_pending_failures_when_the_storage_write_gate_is_closed", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    const source = await makeSource();
    await repository.enqueueCandidates(testEnv.DB, source, [makeCandidate(0)], {});
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("UPDATE pending_items SET status = 'leased', lease_token = 'active-lease', lease_expires_at = ? WHERE source_id = ?")
      .bind(now + 120, source.id).run();
    const item = (await pendingRows())[0];
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();

    await expect(repository.markPendingFailure(testEnv.DB, item, {
      kind: "retryable", nextAttemptAt: now + 300, code: "temporary_fetch_error", message: "retry later",
    })).rejects.toThrow(/storage_limit/);

    expect(await pendingRows()).toMatchObject([{ status: "leased", lease_token: "active-lease", attempts: 0 }]);
    expect(await storageState()).toMatchObject({ storage_state: "storage_limit", reserved_db_bytes: 0 });
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
