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
async function request(app: App, path: string, authenticated = true) { return app.request(path, { headers: authenticated ? { Authorization: `Bearer ${testEnv.API_TOKEN}` } : undefined }, testEnv); }
const now = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES ('source-a', 'https://example.com/a', 'feed', 'example.com'), ('source-b', 'https://example.com/b', 'feed', 'example.com')").run();
  const rows = [
    ["pending-a", "source-a", "article", now - 50, "pending", null, null],
    ["retry-a", "source-a", "article", now - 40, "retry_wait", "fetch_error", "Retry https://private.example/x\u0000 token=secret"],
    ["blocked-a", "source-a", "sitemap", now - 30, "blocked", null, "legacy private detail"],
    ["failed-a", "source-a", "article", now - 20, "failed", "parse_error", "bad\nmessage"],
    ["leased-a", "source-a", "article", now - 10, "leased", "fetch_error", "hidden"],
    ["pending-b", "source-b", "article", now - 60, "pending", null, null],
  ] as const;
  await testEnv.DB.batch(rows.map(([id, source, type, discovered, status, code, message]) => testEnv.DB.prepare("INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at, last_error_code, last_error, attempts, next_attempt_at, terminal_expires_at, lease_token, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, CASE WHEN ? = 'leased' THEN 'secret-lease' ELSE NULL END, CASE WHEN ? = 'leased' THEN ? ELSE NULL END)").bind(id, source, type, id, `https://secret.example/${id}`, status, discovered, code, message, now + 60, ["blocked", "failed"].includes(status) ? now + 3600 : null, status, status, now + 60)));
});

describe("pending API", () => {
  it("requires auth, returns no-store, defaults/maxes limits, filters every supported status and source", async () => {
    const app = await loadApp(); if (!app) return;
    expect((await request(app, "/v1/pending", false)).status).toBe(401);
    const response = await request(app, "/v1/pending");
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json<{ pending: Array<{ status: string }>; next_cursor: string | null }>();
    expect(payload.pending).toHaveLength(5); expect(payload.pending.every((row) => row.status !== "leased")).toBe(true);
    for (const status of ["pending", "retry_wait", "blocked", "failed"]) {
      const filtered = await request(app, `/v1/pending?status=${status}`);
      expect((await filtered.json<{ pending: Array<{ status: string }> }>()).pending.every((row) => row.status === status)).toBe(true);
    }
    expect((await request(app, "/v1/pending?status=leased")).status).toBe(400);
    expect((await request(app, "/v1/pending?source_id=source-b")).status).toBe(200);
    expect((await (await request(app, "/v1/pending?source_id=source-b")).json<{ pending: Array<{ source_id: string }> }>()).pending.every((row) => row.source_id === "source-b")).toBe(true);
    expect((await request(app, "/v1/pending?limit=101")).status).toBe(400);
  });

  it("uses stable keyset pagination, legacy unknown codes, bounded sanitization, and no forbidden fields", async () => {
    const app = await loadApp(); if (!app) return;
    const first = await request(app, "/v1/pending?limit=2");
    const firstPayload = await first.json<{ pending: Array<{ id: string; error_code: string | null; error_message: string | null; [key: string]: unknown }>; next_cursor: string | null }>();
    expect(firstPayload.pending.map((row) => row.id)).toEqual(["failed-a", "blocked-a"]);
    expect(firstPayload.next_cursor).toBeTruthy();
    const second = await request(app, `/v1/pending?limit=2&cursor=${encodeURIComponent(firstPayload.next_cursor ?? "")}`);
    const secondPayload = await second.json<{ pending: Array<{ id: string; error_code: string | null; error_message: string | null }> }>();
    expect(secondPayload.pending.map((row) => row.id)).toEqual(["retry-a", "pending-a"]);
    expect(secondPayload.pending.find((row) => row.id === "retry-a")).toMatchObject({ error_code: "fetch_error" });
    expect(secondPayload.pending.find((row) => row.id === "retry-a")?.error_message).not.toMatch(/https?:\/\/|[\u0000-\u001f]|token=secret/i);
    const blocked = await request(app, "/v1/pending?status=blocked");
    expect((await blocked.json<{ pending: Array<{ error_code: string }> }>()).pending[0]?.error_code).toBe("unknown_error");
    for (const row of firstPayload.pending) for (const forbidden of ["lease_token", "dedupe_key", "canonical_url", "sitemap_cursor", "last_error"]) expect(row).not.toHaveProperty(forbidden);
    expect((await request(app, "/v1/pending?cursor=not-valid")).status).toBe(400);
    const plan = await testEnv.DB.prepare("EXPLAIN QUERY PLAN SELECT id, source_id, item_type, title, status, attempts, next_attempt_at, terminal_expires_at, last_error_code, last_error, discovered_at FROM pending_items WHERE status IN ('pending','retry_wait','blocked','failed') ORDER BY discovered_at DESC, id DESC LIMIT ?").bind(100).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain("idx_pending_status_retry");
    expect(plan.results.map((row) => row.detail).join(" ")).not.toMatch(/articles/i);
  });
});
