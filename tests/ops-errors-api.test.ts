import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment { DB: D1Database; APP_ENV: "test"; API_TOKEN: string; RATE_LIMITER: RateLimit; TEST_MIGRATIONS: D1Migration[] }
interface App { request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response }
const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = { ...runtimeEnv, API_TOKEN: "local-test-token", RATE_LIMITER: { limit: async () => ({ success: true }) } };
const appModules = import.meta.glob<{ createApp(): App }>("../src/app.ts");
async function loadApp() { const moduleLoader = appModules["../src/app.ts"]; expect(moduleLoader).toBeDefined(); return moduleLoader ? (await moduleLoader()).createApp() : undefined; }
async function request(app: App, path: string, authenticated = true) {
  return app.request(path, { headers: authenticated ? { Authorization: `Bearer ${testEnv.API_TOKEN}` } : undefined }, testEnv);
}
const now = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES ('source-a', 'https://example.com/a', 'feed', 'example.com'), ('source-b', 'https://example.com/b', 'feed', 'example.com')"),
    testEnv.DB.prepare("INSERT INTO fetch_runs (id, source_id, started_at, status) VALUES ('run-a', 'source-a', ?, 'failed'), ('run-b', 'source-b', ?, 'partial')").bind(now - 30, now - 20),
    testEnv.DB.prepare("INSERT INTO fetch_run_sources (run_id, source_id_snapshot, source_id, status, error_code, error_message) VALUES ('run-a', 'source-a', 'source-a', 'failed', 'fetch_error', 'run failure'), ('run-b', 'source-b', 'source-b', 'partial', 'fetch_error', 'same code but separate origin')"),
    testEnv.DB.prepare("INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at, terminal_expires_at, last_error_code, last_error) VALUES ('pending-a', 'source-a', 'article', 'a', 'https://secret.example/a', 'failed', ?, ?, 'fetch_error', 'pending failure')").bind(now - 10, now + 3600),
    testEnv.DB.prepare("INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at, terminal_expires_at, last_error) VALUES ('pending-legacy', 'source-a', 'article', 'legacy', 'https://secret.example/legacy', 'blocked', ?, ?, 'legacy private detail')").bind(now - 5, now + 3600),
  ]);
});

describe("errors API", () => {
  it("requires auth, is no-store, separates origins, aggregates bounds and bounded samples", async () => {
    const app = await loadApp(); if (!app) return;
    expect((await request(app, "/v1/errors", false)).status).toBe(401);
    const response = await request(app, "/v1/errors?limit=4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json<{ errors: Array<Record<string, unknown>>; next_cursor: string | null }>();
    expect(payload.errors).toHaveLength(4);
    expect(payload.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "run", source_id: "source-a", code: "fetch_error", status: "failed", count: 1 }),
      expect.objectContaining({ origin: "pending", source_id: "source-a", code: "fetch_error", status: "failed", count: 1 }),
    ]));
    for (const group of payload.errors) {
      expect(group.first_time).toBeTypeOf("number"); expect(group.last_time).toBeTypeOf("number");
      expect(Array.isArray(group.samples)).toBe(true); expect((group.samples as unknown[]).length).toBeLessThanOrEqual(3);
    }
  });

  it("supports source filtering, stable keyset cursors, validates limits/cursors, and reports legacy unknown", async () => {
    const app = await loadApp(); if (!app) return;
    const filtered = await request(app, "/v1/errors?source_id=source-a&limit=3");
    const first = await filtered.json<{ errors: Array<{ source_id: string; code: string }>; next_cursor: string | null }>();
    expect(first.errors.every((row) => row.source_id === "source-a")).toBe(true);
    expect(first.errors.some((row) => row.code === "unknown_error")).toBe(true);
    expect(first.next_cursor).toBeTruthy();
    const paged = await request(app, "/v1/errors?source_id=source-a&limit=1");
    const pagedPayload = await paged.json<{ next_cursor: string | null }>();
    expect(pagedPayload.next_cursor).toBeTruthy();
    const second = await request(app, `/v1/errors?source_id=source-a&limit=1&cursor=${encodeURIComponent(pagedPayload.next_cursor ?? "")}`);
    expect((await second.json<{ errors: unknown[] }>()).errors).toHaveLength(1);
    expect((await request(app, "/v1/errors?limit=0")).status).toBe(400);
    expect((await request(app, "/v1/errors?limit=101")).status).toBe(400);
    expect((await request(app, "/v1/errors?cursor=bad")).status).toBe(400);
    const plan = await testEnv.DB.prepare("EXPLAIN QUERY PLAN SELECT source_id, last_error_code, status, discovered_at FROM pending_items WHERE status IN ('pending', 'retry_wait', 'blocked', 'failed') ORDER BY discovered_at DESC, id DESC LIMIT ?").bind(2).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain("idx_pending");
    expect(plan.results.map((row) => row.detail).join(" ")).not.toMatch(/articles/i);
  });
});
