import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { runScheduled } from "../src/ingest/scheduler";

interface TestEnvironment {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
  APP_ENV: "test";
  API_TOKEN: string;
  TEST_MIGRATIONS: D1Migration[];
}

interface ExportsAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

interface ExportSession {
  id: string;
  snapshot_id: string;
  export_watermark: string;
  expires_at: number;
  state: string;
}

interface ExportRepositoryModule {
  startExport(db: D1Database, now: number): Promise<ExportSession>;
  endExport(db: D1Database, sessionId: string): Promise<void>;
}

interface ExportRecord {
  type: "source" | "pending" | "article";
  record: Record<string, unknown>;
}

interface ExportManifest {
  type: "manifest";
  schema_version: number;
  snapshot_id: string;
  export_watermark: string;
  counts: { sources: number; pending_items: number; articles: number };
  next_cursor: string | null;
}

interface ActiveExportRecovery {
  id: string;
  snapshot_id: string;
  counts: { sources: number; pending_items: number; articles: number };
  expires_at: number;
  cursor: string | null;
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = {
  ...runtimeEnv,
  API_TOKEN: "local-test-token",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<ExportsAppModule>("../src/app.ts");
const repositoryModules = import.meta.glob<ExportRepositoryModule>("../src/exports/repository.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  return module.createApp();
}

async function loadExportRepository() {
  const moduleLoader = repositoryModules["../src/exports/repository.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  return await moduleLoader();
}

async function apiRequest(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  method = "GET",
  body?: unknown,
  requestEnv: TestEnvironment = testEnv,
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    requestEnv,
  );
}

async function seedSource(
  id: string,
  options: { feedWatermark?: string | null; sitemapLastLoc?: string | null } = {},
): Promise<void> {
  await testEnv.DB.prepare(`
    INSERT INTO sources (id, url, kind, host, feed_watermark, sitemap_last_loc, last_status, last_fetched_at)
    VALUES (?, ?, 'feed', 'example.com', ?, ?, 'ok', 1_800_000_000)
  `).bind(
    id,
    `https://example.com/${id}`,
    options.feedWatermark ?? null,
    options.sitemapLastLoc ?? null,
  ).run();
}

async function seedPending(
  id: string,
  sourceId: string,
  status: "pending" | "retry_wait" | "blocked" | "failed",
  options: { metadataSize?: number; attempts?: number } = {},
): Promise<void> {
  const longMetadata = options.metadataSize === undefined ? "" : "m".repeat(options.metadataSize);
  const error = status === "blocked" || status === "failed" ? "blocked_source: retained terminal state" : null;
  const expiresAt = error === null ? null : 1_900_000_000;
  await testEnv.DB.prepare(`
    INSERT INTO pending_items (
      id, source_id, item_type, dedupe_key, external_id, canonical_url, title, summary,
      status, attempts, next_attempt_at, last_error, terminal_expires_at, discovered_at
    ) VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, 1_800_000_000, ?, ?, 1_800_000_000)
  `).bind(
    id,
    sourceId,
    `dedupe-${id}-${longMetadata}`,
    `external-${id}`,
    `https://example.com/${id}`,
    `Pending ${id}`,
    "Retained pending metadata",
    status,
    options.attempts ?? 0,
    error,
    expiresAt,
  ).run();
}

async function seedArticle(id: string, sourceId: string, contentText: string): Promise<void> {
  await testEnv.DB.prepare(`
    INSERT INTO articles (
      id, source_id, canonical_url, title, summary, published_at, fetched_at,
      content_text, content_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')
  `).bind(
    id,
    sourceId,
    `https://example.com/${id}`,
    `Article ${id}`,
    `Summary ${id}`,
    "2026-11-16T12:00:00.000Z",
    1_800_000_000,
    contentText,
    `sha256-${id}`,
  ).run();
}

async function seedLargeExportSnapshot(): Promise<void> {
  await seedSource("budget-source");
  const batchSize = 50;
  const pendingCount = 4_999;
  for (let start = 0; start < pendingCount; start += batchSize) {
    const statements: D1PreparedStatement[] = [];
    for (let index = start; index < Math.min(start + batchSize, pendingCount); index += 1) {
      const id = `budget-pending-${String(index).padStart(5, "0")}`;
      statements.push(testEnv.DB.prepare(`
        INSERT INTO pending_items (
          id, source_id, item_type, dedupe_key, external_id, canonical_url, title, summary,
          status, attempts, next_attempt_at, last_error, terminal_expires_at, discovered_at
        ) VALUES (?, 'budget-source', 'article', ?, ?, ?, ?, 'Budget row', 'pending', 0,
          1800000000, NULL, NULL, 1800000000)
      `).bind(id, `dedupe-${id}`, `external-${id}`, `https://example.com/${id}`, `Pending ${id}`));
    }
    await testEnv.DB.batch(statements);
  }

  const articleCount = 5_000;
  for (let start = 0; start < articleCount; start += batchSize) {
    const statements: D1PreparedStatement[] = [];
    for (let index = start; index < Math.min(start + batchSize, articleCount); index += 1) {
      const id = `budget-article-${String(index).padStart(5, "0")}`;
      statements.push(testEnv.DB.prepare(`
        INSERT INTO articles (
          id, source_id, canonical_url, title, summary, published_at, fetched_at,
          content_text, content_hash, status
        ) VALUES (?, 'budget-source', ?, ?, 'Budget row', '2026-11-16T12:00:00.000Z',
          1800000000, 'x', ?, 'stored')
      `).bind(id, `https://example.com/${id}`, `Article ${id}`, `sha256-${id}`));
    }
    await testEnv.DB.batch(statements);
  }
}

function withReadBudgetTracking(db: D1Database): {
  db: D1Database;
  rowsRead(): number;
  countStatements(): number;
} {
  let rowsRead = 0;
  let countStatements = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const queryByStatement = new WeakMap<object, string>();
  const record = (query: string, result: D1Result<unknown>): void => {
    if (typeof result.meta.rows_read !== "number") {
      throw new Error("D1 query result omitted meta.rows_read");
    }
    rowsRead += result.meta.rows_read;
    if (/COUNT\s*\(\s*\*\s*\)/iu.test(query)) countStatements += 1;
  };
  const wrapStatement = (query: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(query, target.bind(...values));
        }
        if (property === "first") {
          return async <T = unknown>(columnName?: string): Promise<T | null> => {
            const result = await target.all<T>();
            record(query, result as D1Result<unknown>);
            const row = result.results?.[0] ?? null;
            if (row === null || columnName === undefined) return row;
            return ((row as Record<string, unknown>)[columnName] ?? null) as T | null;
          };
        }
        if (property === "all" || property === "run") {
          const method = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<D1Result<unknown>>;
          return async (...args: unknown[]) => {
            const result = await method.apply(target, args);
            record(query, result);
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    queryByStatement.set(proxy, query);
    return proxy;
  };
  const trackedDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(query, target.prepare(query));
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements.map((statement) => originals.get(statement as object) ?? statement));
          statements.forEach((statement, index) => {
            const query = queryByStatement.get(statement as object);
            const statementResult = result[index];
            if (query !== undefined && statementResult !== undefined) record(query, statementResult);
          });
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: trackedDb, rowsRead: () => rowsRead, countStatements: () => countStatements };
}

function parsePage(text: string): { manifest: ExportManifest; records: ExportRecord[] } {
  const lines = text.trimEnd().split("\n");
  const parsed = lines.map((line) => JSON.parse(line) as ExportManifest | ExportRecord);
  return {
    manifest: parsed[0] as ExportManifest,
    records: parsed.slice(1) as ExportRecord[],
  };
}

async function startExport(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  requestEnv: TestEnvironment = testEnv,
) {
  const response = await apiRequest(app, "/v1/exports", "POST", undefined, requestEnv);
  expect(response.status).toBe(201);
  return (await response.json<{ session: ExportSession }>()).session;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("consistent export API", () => {
  it("recovers_only_the_live_export_with_its_counts_expiry_and_current_cursor", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedSource("recovery-source");
    for (let index = 0; index < 12; index += 1) {
      await seedArticle(`recovery-article-${String(index).padStart(2, "0")}`, "recovery-source", `Body ${index}`);
    }
    const session = await startExport(app);
    const pageResponse = await apiRequest(app, `/v1/exports/${session.id}`);
    const { manifest } = parsePage(new TextDecoder().decode(await pageResponse.arrayBuffer()));
    expect(manifest.next_cursor).toBeTypeOf("string");

    const response = await apiRequest(app, "/v1/exports/active");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json<{ session: ActiveExportRecovery }>()).toEqual({
      session: {
        id: session.id,
        snapshot_id: session.snapshot_id,
        counts: { sources: 1, pending_items: 0, articles: 12 },
        expires_at: session.expires_at,
        cursor: manifest.next_cursor,
      },
    });
  });

  it("returns_an_explicit_empty_recovery_result_and_keeps_auth_failures_no_store", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await apiRequest(app, "/v1/exports/active");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ session: null });

    const unauthorized = await app.request("/v1/exports/active", { method: "GET" }, testEnv);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
  });

  it("excludes_stale_locks_and_does_not_audit_an_expired_end_attempt", async () => {
    const app = await loadApp();
    if (!app) return;
    const session = await startExport(app);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("UPDATE system_state SET export_lock_id = 'stale-lock' WHERE singleton_id = 'global'").run();

    const stale = await apiRequest(app, "/v1/exports/active");
    expect(await stale.json()).toEqual({ session: null });

    await testEnv.DB.prepare("UPDATE system_state SET export_lock_id = ?, export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(session.id, now - 1).run();
    await testEnv.DB.prepare("UPDATE export_sessions SET expires_at = ? WHERE id = ?")
      .bind(now - 1, session.id).run();

    const expired = await apiRequest(app, "/v1/exports/active");
    expect(await expired.json()).toEqual({ session: null });
    const endAttempt = await apiRequest(app, `/v1/exports/${session.id}`, "DELETE");
    expect(endAttempt.status).toBe(410);
    expect(await testEnv.DB.prepare("SELECT action FROM operator_actions ORDER BY created_at, rowid").all())
      .toMatchObject({ results: [{ action: "export.started" }] });
  });

  it("rolls_back_export_start_and_its_lock_when_audit_insertion_fails", async () => {
    const app = await loadApp();
    if (!app) return;
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_export_started_audit
      BEFORE INSERT ON operator_actions
      WHEN NEW.action = 'export.started'
      BEGIN
        SELECT RAISE(ABORT, 'induced export audit failure');
      END
    `).run();

    const response = await apiRequest(app, "/v1/exports", "POST");

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await testEnv.DB.prepare("SELECT export_lock, export_lock_id FROM system_state WHERE singleton_id = 'global'").first())
      .toEqual({ export_lock: 0, export_lock_id: null });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM export_sessions").first())
      .toEqual({ count: 0 });
    expect(await testEnv.DB.prepare("SELECT id FROM operator_actions").first()).toBeNull();
  });

  it("rolls_back_export_end_and_keeps_the_live_session_when_audit_insertion_fails", async () => {
    const app = await loadApp();
    if (!app) return;
    const session = await startExport(app);
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_export_ended_audit
      BEFORE INSERT ON operator_actions
      WHEN NEW.action = 'export.ended'
      BEGIN
        SELECT RAISE(ABORT, 'induced export audit failure');
      END
    `).run();

    const response = await apiRequest(app, `/v1/exports/${session.id}`, "DELETE");

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await testEnv.DB.prepare("SELECT export_lock, export_lock_id FROM system_state WHERE singleton_id = 'global'").first())
      .toEqual({ export_lock: 1, export_lock_id: session.id });
    expect(await testEnv.DB.prepare("SELECT id, state FROM export_sessions WHERE id = ?").bind(session.id).first())
      .toEqual({ id: session.id, state: "active" });
    expect(await testEnv.DB.prepare("SELECT action FROM operator_actions ORDER BY created_at, rowid").all())
      .toMatchObject({ results: [{ action: "export.started" }] });
  });

  it("locks_ingestion_and_all_source_mutations_until_endExport_releases_the_lock", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedSource("locked-source");
    const session = await startExport(app);

    const scheduled = await runScheduled(testEnv, Date.now());
    const created = await apiRequest(app, "/v1/sources", "POST", {
      kind: "feed",
      url: "https://example.com/new-source.xml",
    });
    const changed = await apiRequest(app, "/v1/sources/locked-source", "PATCH", { poll_interval_sec: 900 });
    const disabled = await apiRequest(app, "/v1/sources/locked-source", "PATCH", { enabled: false });
    const deleted = await apiRequest(app, "/v1/sources/locked-source", "DELETE");

    expect(scheduled.status).toBe("export_locked");
    expect(created.status).toBe(423);
    expect(changed.status).toBe(423);
    expect(disabled.status).toBe(423);
    expect(deleted.status).toBe(423);

    const ended = await apiRequest(app, `/v1/exports/${session.id}`, "DELETE");
    expect(ended.status).toBe(200);
    const actions = await testEnv.DB.prepare(`
      SELECT action, target_type, target_id, changed_fields_json
      FROM operator_actions ORDER BY rowid
    `).all<{ action: string; target_type: string; target_id: string; changed_fields_json: string }>();
    expect(actions.results.map((action) => ({
      action: action.action,
      target_type: action.target_type,
      target_id: action.target_id,
      changed_fields: JSON.parse(action.changed_fields_json) as string[],
    }))).toEqual([
      {
        action: "export.started",
        target_type: "export",
        target_id: session.id,
        changed_fields: ["state", "snapshot_id", "cursor", "expires_at", "snapshot_sources_count", "snapshot_pending_items_count", "snapshot_articles_count"],
      },
      {
        action: "export.ended",
        target_type: "export",
        target_id: session.id,
        changed_fields: ["state", "expires_at"],
      },
    ]);
    expect(await testEnv.DB.prepare("SELECT export_lock, export_lock_id, export_lock_expires_at FROM system_state WHERE singleton_id = 'global'").first())
      .toEqual({ export_lock: 0, export_lock_id: null, export_lock_expires_at: null });
    expect(await testEnv.DB.prepare("SELECT id FROM export_sessions WHERE id = ?").bind(session.id).first()).toBeNull();
  });

  it("sets_a_30_minute_expiry_and_reclaims_the_existing_lock_at_expiry", async () => {
    const repository = await loadExportRepository();
    if (!repository) return;
    const now = Math.floor(Date.now() / 1000);

    const first = await repository.startExport(testEnv.DB, now);
    expect(first.expires_at).toBe(now + 30 * 60);
    const second = await repository.startExport(testEnv.DB, first.expires_at);

    expect(second.id).not.toBe(first.id);
    expect(second.expires_at).toBe(first.expires_at + 30 * 60);
    expect(await testEnv.DB.prepare("SELECT id FROM export_sessions WHERE id = ?").bind(first.id).first())
      .toBeNull();
    await repository.endExport(testEnv.DB, second.id);
  });

  it("purges_stale_export_sessions_without_removing_an_active_session_or_lock", async () => {
    const repository = await loadExportRepository();
    if (!repository) return;
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(`
      INSERT INTO export_sessions (id, snapshot_id, export_watermark, expires_at, state, created_at, updated_at)
      VALUES ('stale-completed', 'snapshot-old-1', '1', ?, 'completed', ?, ?),
             ('stale-expired', 'snapshot-old-2', '2', ?, 'expired', ?, ?)
    `).bind(now - 1, now - 100, now - 100, now - 1, now - 100, now - 100).run();
    const active = await repository.startExport(testEnv.DB, now);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM export_sessions").first<{ count: number }>();
    const lock = await testEnv.DB.prepare("SELECT export_lock, export_lock_id FROM system_state WHERE singleton_id = 'global'")
      .first<{ export_lock: number; export_lock_id: string | null }>();

    expect(count?.count).toBe(1);
    expect(await testEnv.DB.prepare("SELECT id FROM export_sessions WHERE id IN ('stale-completed', 'stale-expired')").first()).toBeNull();
    expect(lock).toEqual({ export_lock: 1, export_lock_id: active.id });
    await repository.endExport(testEnv.DB, active.id);
  });

  it("refuses_to_create_an_export_session_when_the_storage_gate_is_closed", async () => {
    const app = await loadApp();
    if (!app) return;
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();

    const response = await apiRequest(app, "/v1/exports", "POST");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "storage_limit" } });
    expect(await testEnv.DB.prepare("SELECT export_lock, export_lock_id FROM system_state WHERE singleton_id = 'global'").first())
      .toEqual({ export_lock: 0, export_lock_id: null });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM export_sessions").first())
      .toEqual({ count: 0 });
  });

  it("refuses_to_start_until_an_existing_ingestion_lease_has_finished", async () => {
    const repository = await loadExportRepository();
    if (!repository) return;
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(`
      UPDATE system_state
      SET global_lease_token = 'active-ingestion', global_lease_expires_at = ?
      WHERE singleton_id = 'global'
    `).bind(now + 60).run();

    await expect(repository.startExport(testEnv.DB, now)).rejects.toThrow();
    expect(await testEnv.DB.prepare("SELECT export_lock FROM system_state WHERE singleton_id = 'global'").first())
      .toEqual({ export_lock: 0 });
    expect(await testEnv.DB.prepare("SELECT id FROM operator_actions").first()).toBeNull();
  });

  it("paginates_without_gaps_or_duplicates_and_emits_schema_sources_watermarks_pending_and_full_text", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedSource("page-source", { feedWatermark: "feed-cursor-42", sitemapLastLoc: "sitemap-cursor-9" });
    await seedPending("pending-retry", "page-source", "retry_wait", { attempts: 3 });
    await seedPending("pending-terminal", "page-source", "blocked");
    await seedPending("pending-open", "page-source", "pending");
    for (let index = 0; index < 14; index += 1) {
      const articleId = `article-${String(index).padStart(2, "0")}`;
      await seedArticle(articleId, "page-source", `Full text body ${index}.`);
    }
    const session = await startExport(app);

    const records: ExportRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const path = cursor === null ? `/v1/exports/${session.id}` : `/v1/exports/${session.id}?cursor=${encodeURIComponent(cursor)}`;
      const response = await apiRequest(app, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
      const text = new TextDecoder().decode(await response.arrayBuffer());
      const bytes = new TextEncoder().encode(text).byteLength;
      const { manifest, records: pageRecords } = parsePage(text);

      expect(bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
      expect(pageRecords.length + 1).toBeLessThanOrEqual(10);
      expect(manifest).toMatchObject({
        type: "manifest",
        schema_version: 1,
        snapshot_id: session.snapshot_id,
        export_watermark: session.export_watermark,
        counts: { sources: 1, pending_items: 3, articles: 14 },
      });
      records.push(...pageRecords);
      if (manifest.next_cursor === null) break;
      expect(seenCursors.has(manifest.next_cursor)).toBe(false);
      seenCursors.add(manifest.next_cursor);
      cursor = manifest.next_cursor;
    }

    expect(records.filter((record) => record.type === "source").map((record) => record.record.id)).toEqual(["page-source"]);
    expect(records.filter((record) => record.type === "pending").map((record) => record.record.id).sort())
      .toEqual(["pending-open", "pending-retry", "pending-terminal"]);
    expect(records.find((record) => record.type === "pending" && record.record.id === "pending-retry")?.record)
      .toMatchObject({ status: "retry_wait", attempts: 3 });
    expect(records.find((record) => record.type === "pending" && record.record.id === "pending-terminal")?.record)
      .toMatchObject({ status: "blocked" });
    expect(records.find((record) => record.type === "source")?.record)
      .toMatchObject({ feed_watermark: "feed-cursor-42", sitemap_last_loc: "sitemap-cursor-9", last_status: "ok" });
    const articles = records.filter((record) => record.type === "article");
    expect(articles).toHaveLength(14);
    expect(articles.map((record) => record.record.id)).toEqual(
      [...articles.map((record) => String(record.record.id))].sort(),
    );
    expect(articles[0]?.record).toHaveProperty("content_text_base64");
  });

  it("keeps_each_page_under_3_MiB_with_maximum_article_bodies_and_large_pending_metadata", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedSource("large-source", { feedWatermark: "w".repeat(4096), sitemapLastLoc: "s".repeat(4096) });
    for (let index = 0; index < 4; index += 1) {
      await seedPending(`large-pending-${index}`, "large-source", index === 0 ? "blocked" : "pending", { metadataSize: 3500 });
    }
    const maxBody = "z".repeat(512_000);
    for (let index = 0; index < 6; index += 1) {
      await seedArticle(`large-article-${index}`, "large-source", maxBody);
    }
    const session = await startExport(app);

    const response = await apiRequest(app, `/v1/exports/${session.id}`);
    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    const { manifest, records } = parsePage(text);

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(records.length + 1).toBeLessThanOrEqual(10);
    expect(manifest.next_cursor).toBeTypeOf("string");
    const firstLargeArticle = records.find((record) => record.type === "article");
    expect(firstLargeArticle).toBeDefined();
    const encoded = String(firstLargeArticle?.record.content_text_base64);
    const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    expect(new TextDecoder().decode(decoded)).toBe(maxBody);
  });

  it("rejects_a_cursor_from_a_different_or_malformed_export", async () => {
    const app = await loadApp();
    if (!app) return;
    const session = await startExport(app);

    const response = await apiRequest(app, `/v1/exports/${session.id}?cursor=not-a-cursor`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_export_cursor" } });
  });

  it("keeps_a_10,000_record_export_below_the_daily_read_quota_without_recounting_tables", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedLargeExportSnapshot();
    const readBudget = withReadBudgetTracking(testEnv.DB);
    const trackedEnv: TestEnvironment = { ...testEnv, DB: readBudget.db };
    const session = await startExport(app, trackedEnv);

    let cursor: string | null = null;
    let pages = 0;
    let exportedRecords = 0;
    do {
      const path = cursor === null
        ? `/v1/exports/${session.id}`
        : `/v1/exports/${session.id}?cursor=${encodeURIComponent(cursor)}`;
      const response = await apiRequest(app, path, "GET", undefined, trackedEnv);
      expect(response.status).toBe(200);
      const text = new TextDecoder().decode(await response.arrayBuffer());
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
      const { manifest, records } = parsePage(text);
      expect(manifest.counts).toEqual({ sources: 1, pending_items: 4_999, articles: 5_000 });
      expect(records.length + 1).toBeLessThanOrEqual(10);
      exportedRecords += records.length;
      pages += 1;
      cursor = manifest.next_cursor;
      expect(pages).toBeLessThanOrEqual(1_112);
    } while (cursor !== null);

    expect(exportedRecords).toBe(10_000);
    expect(pages).toBe(1_112);
    expect(readBudget.rowsRead()).toBeLessThan(5_000_000);
    expect(readBudget.countStatements()).toBe(1);
    await apiRequest(app, `/v1/exports/${session.id}`, "DELETE", undefined, trackedEnv);
  }, 120_000);
});
