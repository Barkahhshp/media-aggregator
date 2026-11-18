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

interface RunsAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = {
  ...runtimeEnv,
  API_TOKEN: "local-test-token",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<RunsAppModule>("../src/app.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.createApp).toBeTypeOf("function");
  if (!module.createApp) return undefined;
  return module.createApp();
}

async function runRequest(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  authenticated = true,
): Promise<Response> {
  const headers = authenticated ? new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` }) : undefined;
  return await app.request(path, { headers }, testEnv);
}

function hasControlCharacters(value: string | null | undefined): boolean {
  return [...(value ?? "")].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

const now = Math.floor(Date.now() / 1000);

afterEach(() => vi.useRealTimers());

async function seedRuns(): Promise<void> {
  const source = (id: string) => testEnv.DB.prepare(`
    INSERT INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')
  `).bind(id, `https://example.com/${id}`);
  await source("source-a").run();
  await source("source-b").run();
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status, discovered_count, stored_count)
      VALUES ('run-new', 'source-a', ?, ?, 'succeeded', 4, 3)`).bind(now - 100, now - 40),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status, discovered_count, stored_count)
      VALUES ('run-tie-b', 'source-b', ?, ?, 'failed', 2, 0)`).bind(now - 200, now - 150),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status, discovered_count, stored_count)
      VALUES ('run-tie-a', 'source-a', ?, ?, 'partial', 5, 2)`).bind(now - 200, now - 120),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, status, discovered_count, stored_count)
      VALUES ('run-live', 'source-b', ?, 'running', 1, 0)`).bind(now - 30),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status)
      VALUES ('run-boundary', 'source-a', ?, ?, 'succeeded')`).bind(now - 30 * 86400, now - 30 * 86400 + 1),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status)
      VALUES ('run-old', 'source-a', ?, ?, 'succeeded')`).bind(now - 30 * 86400 - 1, now - 30 * 86400),
    testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status)
      VALUES ('run-legacy-trap', 'source-a', ?, ?, 'failed')`).bind(now - 500, now - 450),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, http_status, discovered_count, stored_count, error_code, error_message)
      VALUES ('run-new', 'source-a', 'source-a', 'succeeded', 200, 4, 3, NULL, NULL)`),
    testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, http_status, discovered_count, stored_count, error_code, error_message)
      VALUES ('run-new', 'source-b', 'source-b', 'failed', 500, 7, 1, 'fetch_error', 'bad feed')`),
    testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, http_status, discovered_count, stored_count, error_code, error_message)
      VALUES ('run-legacy-trap', 'historical-source', NULL, 'succeeded', 200, 9, 8, NULL, NULL)`),
    testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, http_status, discovered_count, stored_count)
      VALUES ('run-tie-b', 'source-b', 'source-b', 'failed', 500, 2, 0)`),
    testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, http_status, discovered_count, stored_count)
      VALUES ('run-tie-a', 'source-a', 'source-a', 'partial', 200, 5, 2)`),
  ]);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await seedRuns();
});

describe("run history API", () => {
  it("requires authentication and returns no-store responses", async () => {
    const app = await loadApp();
    if (!app) return;
    expect((await runRequest(app, "/v1/runs", false)).status).toBe(401);
    const response = await runRequest(app, "/v1/runs");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lists the last 30 days by stable started_at/id order with default and maximum limits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now * 1000);
    const app = await loadApp();
    if (!app) return;
    const response = await runRequest(app, "/v1/runs");
    const payload = await response.json<{ runs: Array<{ id: string }>; next_cursor: string | null }>();
    expect(response.status).toBe(200);
    expect(payload.runs.map((run) => run.id)).toEqual(["run-live", "run-new", "run-tie-b", "run-tie-a", "run-legacy-trap", "run-boundary"]);
    expect(payload.next_cursor).toBeNull();

    const max = await runRequest(app, "/v1/runs?limit=100");
    expect((await max.json<{ runs: unknown[] }>()).runs).toHaveLength(6);
    expect((await runRequest(app, "/v1/runs?limit=101")).status).toBe(400);
    expect((await runRequest(app, "/v1/runs?limit=0")).status).toBe(400);
    expect((await runRequest(app, "/v1/runs?limit=nope")).status).toBe(400);
    expect((await runRequest(app, "/v1/runs?limit=1.5")).status).toBe(400);
  });

  it("supports an opaque stable cursor, rejects tampering, and does not use OFFSET", async () => {
    const app = await loadApp();
    if (!app) return;
    const first = await runRequest(app, "/v1/runs?limit=2");
    const firstPayload = await first.json<{ runs: Array<{ id: string }>; next_cursor: string | null }>();
    expect(firstPayload.runs.map((run) => run.id)).toEqual(["run-live", "run-new"]);
    expect(firstPayload.next_cursor).toBeTruthy();
    const second = await runRequest(app, `/v1/runs?limit=2&cursor=${encodeURIComponent(firstPayload.next_cursor ?? "")}`);
    expect((await second.json<{ runs: Array<{ id: string }> }>()).runs.map((run) => run.id)).toEqual(["run-tie-b", "run-tie-a"]);
    expect((await runRequest(app, "/v1/runs?cursor=not-a-valid-cursor")).status).toBe(400);
    expect((await runRequest(app, "/v1/runs?cursor=eyJ2IjoxLCJzdGFydGVkX2F0IjoxLCJpZCI6Ingi")).status).toBe(400);

    const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM fetch_runs
      WHERE started_at >= ? AND (started_at < ? OR (started_at = ? AND id < ?))
      ORDER BY started_at DESC, id DESC LIMIT 2`).bind(now - 30 * 86400, now - 200, now - 200, "run-tie-b").all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain("idx_fetch_runs_started");
    expect(plan.results.map((row) => row.detail).join(" ")).not.toMatch(/OFFSET/i);
  });

  it("filters by status and source snapshot rather than legacy global source attribution", async () => {
    const app = await loadApp();
    if (!app) return;
    const status = await runRequest(app, "/v1/runs?status=failed");
    expect((await status.json<{ runs: Array<{ id: string }> }>()).runs.map((run) => run.id)).toEqual(["run-tie-b", "run-legacy-trap"]);
    expect((await runRequest(app, "/v1/runs?status=unknown")).status).toBe(400);
    const source = await runRequest(app, "/v1/runs?source_id=historical-source");
    expect((await source.json<{ runs: Array<{ id: string }> }>()).runs.map((run) => run.id)).toEqual(["run-legacy-trap"]);
    const sourcePlan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN SELECT id, source_id, started_at, finished_at, status, http_status, discovered_count, stored_count, error_code, error_message
      FROM fetch_runs
      WHERE started_at >= ?
        AND EXISTS (SELECT 1 FROM fetch_run_sources AS source_filter INDEXED BY idx_fetch_run_sources_source_run
          WHERE source_filter.run_id = fetch_runs.id AND source_filter.source_id_snapshot = ?)
      ORDER BY started_at DESC, id DESC LIMIT ?`).bind(now - 30 * 86400, "historical-source", 50).all<{ detail: string }>();
    expect(sourcePlan.results.map((row) => row.detail).join(" ")).toContain("idx_fetch_run_sources_source_run");
  });

  it("sanitizes and bounds legacy error fields on both list and detail reads", async () => {
    const app = await loadApp();
    if (!app) return;
    const malformedMessage = `${"x".repeat(1010)}\nhttps://secret.example/path Bearer top-secret token=abc@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO fetch_runs (id, source_id, started_at, finished_at, status, error_code, error_message)
        VALUES ('run-malformed-errors', 'source-a', ?, ?, 'failed', ' BAD CODE ', ?)`)
        .bind(now - 400, now - 300, malformedMessage.slice(0, 1024)),
      testEnv.DB.prepare(`INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, error_code, error_message)
        VALUES ('run-malformed-errors', 'source-a', 'source-a', 'failed', ' BAD SOURCE CODE ', ?)`)
        .bind(malformedMessage.slice(0, 1024)),
    ]);

    const list = await runRequest(app, "/v1/runs");
    const listed = (await list.json<{ runs: Array<{ id: string; error_code: string | null; error_message: string | null }> }>()).runs
      .find((run) => run.id === "run-malformed-errors");
    expect(listed).toMatchObject({ id: "run-malformed-errors", error_code: "unknown_error" });
    expect(hasControlCharacters(listed?.error_message)).toBe(false);
    expect(listed?.error_message).not.toContain("https://");
    expect(listed?.error_message).not.toContain("Bearer top-secret");
    expect(listed?.error_message).toHaveLength(1024);

    const detail = await runRequest(app, "/v1/runs/run-malformed-errors");
    const detailPayload = await detail.json<{ run: { error_code: string | null; error_message: string | null }; sources: Array<{ error_code: string | null; error_message: string | null }> }>();
    expect(detailPayload.run.error_code).toBe("unknown_error");
    expect(hasControlCharacters(detailPayload.run.error_message)).toBe(false);
    expect(detailPayload.run.error_message).toHaveLength(1024);
    expect(detailPayload.sources[0]?.error_code).toBe("unknown_error");
    expect(hasControlCharacters(detailPayload.sources[0]?.error_message)).toBe(false);
    expect(detailPayload.sources[0]?.error_message).toHaveLength(1024);
  });

  it("returns run-global detail, computed live/finished durations, and source summaries", async () => {
    const app = await loadApp();
    if (!app) return;
    const response = await runRequest(app, "/v1/runs/run-new");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { id: "run-new", source_id: "source-a", status: "succeeded", duration_seconds: 60, discovered_count: 4, stored_count: 3 },
      sources: [
        { source_id_snapshot: "source-a", status: "succeeded", http_status: 200, discovered_count: 4, stored_count: 3 },
        { source_id_snapshot: "source-b", status: "failed", error_code: "fetch_error", error_message: "bad feed" },
      ],
    });
    const live = await runRequest(app, "/v1/runs/run-live");
    const livePayload = await live.json<{ run: { duration_seconds: number } }>();
    expect(livePayload.run.duration_seconds).toBeGreaterThanOrEqual(29);
    expect(livePayload.run.duration_seconds).toBeLessThanOrEqual(35);
    expect((await runRequest(app, "/v1/runs/no-such-run")).status).toBe(404);
    expect((await runRequest(app, "/v1/runs/run-new", false)).status).toBe(401);
  });

  it("uses the existing generic error envelope for database failures", async () => {
    const app = await loadApp();
    if (!app) return;
    const statement: Record<string, unknown> = { bind: () => statement, first: async () => { throw new Error("secret SQL details"); } };
    const failingEnv = { ...testEnv, DB: { prepare: () => statement } as unknown as D1Database };
    const response = await app.request("/v1/runs/no-such-run", { headers: { Authorization: `Bearer ${testEnv.API_TOKEN}` } }, failingEnv);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error", message: "Internal server error" } });
  });
});
