import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN: string;
  RATE_LIMITER: RateLimit;
  TEST_MIGRATIONS: D1Migration[];
}

interface App {
  request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
}

interface OverviewPayload {
  storage: {
    state: string;
    observed_db_size: number;
    warning_threshold_bytes: number;
    hard_stop_threshold_bytes: number;
  };
  pending: {
    active_count: number;
    disabled_count: number;
    oldest_age_seconds: number | null;
    by_status: {
      active: Record<string, number>;
      disabled: Record<string, number>;
    };
  };
  sources: { enabled_count: number; disabled_count: number; overdue_count: number };
  runs_24h: Record<string, number>;
  latest_run: null | {
    id: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    http_status: number | null;
    discovered_count: number;
    stored_count: number;
    error_code: string | null;
    error_message: string | null;
    duration_seconds: number;
  };
}

const FIXED_NOW = 1_800_000_000;
const ONE_DAY = 24 * 60 * 60;
const WARNING_THRESHOLD_BYTES = 280 * 1024 * 1024;
const HARD_STOP_THRESHOLD_BYTES = 300 * 1024 * 1024;
const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = {
  ...runtimeEnv,
  API_TOKEN: "local-test-token",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<{ createApp(): App }>("../src/app.ts");

async function loadApp(): Promise<App | undefined> {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  return (await moduleLoader()).createApp();
}

async function request(app: App, authenticated = true, requestEnv = testEnv): Promise<Response> {
  const headers = authenticated ? { Authorization: `Bearer ${testEnv.API_TOKEN}` } : undefined;
  return await app.request("/v1/overview", { headers }, requestEnv);
}

interface PendingFixture {
  id: string;
  sourceId: string;
  status: "pending" | "leased" | "retry_wait" | "blocked" | "failed";
  discoveredAt: number;
}

const pendingFixtures: PendingFixture[] = [
  { id: "active-pending", sourceId: "active-a", status: "pending", discoveredAt: FIXED_NOW - 100 },
  { id: "active-leased", sourceId: "active-a", status: "leased", discoveredAt: FIXED_NOW - 90 },
  { id: "active-retry", sourceId: "active-b", status: "retry_wait", discoveredAt: FIXED_NOW - 80 },
  { id: "active-blocked", sourceId: "active-b", status: "blocked", discoveredAt: FIXED_NOW - 70 },
  { id: "active-failed", sourceId: "active-b", status: "failed", discoveredAt: FIXED_NOW - 60 },
  { id: "disabled-pending", sourceId: "disabled", status: "pending", discoveredAt: FIXED_NOW - 50 },
  { id: "disabled-leased", sourceId: "disabled", status: "leased", discoveredAt: FIXED_NOW - 40 },
  { id: "disabled-retry", sourceId: "disabled", status: "retry_wait", discoveredAt: FIXED_NOW - 30 },
  { id: "disabled-blocked", sourceId: "disabled", status: "blocked", discoveredAt: FIXED_NOW - 20 },
  { id: "disabled-failed", sourceId: "disabled", status: "failed", discoveredAt: FIXED_NOW - 10 },
];

async function seedOverviewFixture(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO sources (id, url, kind, host, enabled, next_fetch_at) VALUES
      ('active-a', 'https://example.com/a', 'feed', 'example.com', 1, ?),
      ('active-b', 'https://example.com/b', 'feed', 'example.com', 1, ?),
      ('disabled', 'https://example.com/disabled', 'feed', 'example.com', 0, ?)`)
      .bind(FIXED_NOW, FIXED_NOW + 1, FIXED_NOW - 500),
    testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(WARNING_THRESHOLD_BYTES),
  ]);

  await testEnv.DB.batch(pendingFixtures.map((item) => {
    const isLeased = item.status === "leased";
    const isTerminal = item.status === "blocked" || item.status === "failed";
    return testEnv.DB.prepare(`INSERT INTO pending_items (
      id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at,
      lease_token, lease_expires_at, terminal_expires_at
    ) VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        item.id,
        item.sourceId,
        `dedupe-${item.id}`,
        `https://example.com/articles/${item.id}`,
        item.status,
        item.discoveredAt,
        isLeased ? `lease-${item.id}` : null,
        isLeased ? FIXED_NOW + 60 : null,
        isTerminal ? FIXED_NOW + ONE_DAY : null,
      );
  }));

  const cutoff = FIXED_NOW - ONE_DAY;
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status, discovered_count, stored_count) VALUES ('run-boundary', ?, ?, 'succeeded', 10, 8)")
      .bind(cutoff, cutoff + 1),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-partial', ?, ?, 'partial')")
      .bind(FIXED_NOW - 100, FIXED_NOW - 90),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-failed', ?, ?, 'failed')")
      .bind(FIXED_NOW - 80, FIXED_NOW - 70),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-blocked', ?, ?, 'blocked')")
      .bind(FIXED_NOW - 60, FIXED_NOW - 50),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-storage', ?, ?, 'storage_limit')")
      .bind(FIXED_NOW - 40, FIXED_NOW - 30),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (
      id, started_at, status, http_status, discovered_count, stored_count, error_code, error_message
    ) VALUES ('run-live', ?, 'running', 503, 7, 2, 'INVALID CODE', ?) `)
      .bind(FIXED_NOW - 20, "bad https://secret.example/path\nBearer leaked-token token=abc"),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-future', ?, ?, 'failed')")
      .bind(FIXED_NOW + 1, FIXED_NOW + 2),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('run-old', ?, ?, 'succeeded')")
      .bind(cutoff - 1, cutoff),
  ]);
}

interface CapturedQuery {
  sql: string;
  bindings: unknown[];
}

function queryCountingDatabase(db: D1Database, captured: CapturedQuery[]): D1Database {
  const wrapStatement = (statement: D1PreparedStatement, sql: string, bindings: unknown[] = []) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrapStatement(target.bind(...values), sql, values);
      }
      if (property === "first" || property === "all" || property === "run") {
        return (...args: unknown[]) => {
          captured.push({ sql, bindings });
          const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW * 1000);
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await seedOverviewFixture();
});

afterEach(() => vi.useRealTimers());

describe("overview API", () => {
  it("returns exact storage, pending-by-status, source, 24-hour run, and latest-run values", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await request(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json<OverviewPayload>();

    expect(payload.storage).toEqual({
      state: "storage_limit",
      observed_db_size: WARNING_THRESHOLD_BYTES,
      warning_threshold_bytes: WARNING_THRESHOLD_BYTES,
      hard_stop_threshold_bytes: HARD_STOP_THRESHOLD_BYTES,
    });
    expect(payload.pending).toEqual({
      active_count: 3,
      disabled_count: 3,
      oldest_age_seconds: 100,
      by_status: {
        active: { pending: 1, leased: 1, retry_wait: 1, blocked: 1, failed: 1 },
        disabled: { pending: 1, leased: 1, retry_wait: 1, blocked: 1, failed: 1 },
      },
    });
    expect(payload.sources).toEqual({ enabled_count: 2, disabled_count: 1, overdue_count: 1 });
    expect(payload.runs_24h).toEqual({ running: 1, succeeded: 1, partial: 1, failed: 1, blocked: 1, storage_limit: 1 });
    expect(payload.latest_run).toEqual({
      id: "run-live",
      started_at: FIXED_NOW - 20,
      finished_at: null,
      status: "running",
      http_status: 503,
      discovered_count: 7,
      stored_count: 2,
      error_code: "unknown_error",
      error_message: "bad [redacted-url] Bearer [redacted] token=[redacted]",
      duration_seconds: 20,
    });
  });

  it("requires authentication and exposes the configured 280/300 MiB thresholds", async () => {
    const app = await loadApp();
    if (!app) return;

    const rejected = await request(app, false);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect((await rejected.text()).includes(testEnv.API_TOKEN)).toBe(false);

    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'read_only' WHERE singleton_id = 'global'")
      .bind(HARD_STOP_THRESHOLD_BYTES)
      .run();
    const response = await request(app);
    const payload = await response.json<OverviewPayload>();
    expect(payload.storage).toEqual({
      state: "read_only",
      observed_db_size: HARD_STOP_THRESHOLD_BYTES,
      warning_threshold_bytes: WARNING_THRESHOLD_BYTES,
      hard_stop_threshold_bytes: HARD_STOP_THRESHOLD_BYTES,
    });
  });

  it("uses indexed bounded summaries, avoids articles, and stays well below the 50-query budget with a large article fixture", async () => {
    const app = await loadApp();
    if (!app) return;

    await testEnv.DB.prepare(`WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500
    )
    INSERT INTO articles (id, source_id, canonical_url, title, content_text, content_hash)
    SELECT 'bulk-' || n, 'active-a', 'https://example.com/bulk/' || n, 'Bulk article ' || n, '', 'hash-' || n
    FROM seq`).run();

    const captured: CapturedQuery[] = [];
    const countingEnv: TestEnvironment = {
      ...testEnv,
      DB: queryCountingDatabase(testEnv.DB, captured),
    };
    const response = await request(app, true, countingEnv);
    expect(response.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.length).toBeLessThan(50);
    expect(captured).toHaveLength(5);
    expect(captured.map((query) => query.sql).join("\n")).not.toMatch(/\barticles\b/i);
    expect((await response.json<OverviewPayload>()).sources.enabled_count).toBe(2);

    const details = new Map<string, string>();
    for (const query of captured) {
      const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      const description = plan.results.map((row) => row.detail).join(" ");
      details.set(query.sql, description);
      expect(description).not.toMatch(/articles/i);
      if (/\bFROM\s+sources\b/i.test(query.sql)) expect(description).toContain("idx_sources_due");
      if (/\bFROM\s+pending_items\b/i.test(query.sql)) expect(description).toContain("idx_pending_source_status");
      if (/\bFROM\s+fetch_runs\b/i.test(query.sql)) expect(description).toContain("idx_fetch_runs_started");
    }
    expect([...details.values()].some((description) => /SCAN\s+articles/i.test(description))).toBe(false);
  });
});
