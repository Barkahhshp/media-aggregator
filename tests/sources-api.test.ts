import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { createSource } from "../src/sources/repository";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN: string;
  ACCESS_AUD?: string;
  RATE_LIMITER: RateLimit;
  TEST_MIGRATIONS: D1Migration[];
}

interface AccessExecutionContext {
  access: {
    aud: string;
    getIdentity(): Promise<Record<string, unknown> | undefined>;
  };
}

interface SourcesAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment, executionCtx?: AccessExecutionContext): Promise<Response> | Response;
  };
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = {
  ...runtimeEnv,
  API_TOKEN: "local-test-token",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<SourcesAppModule>("../src/app.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;

  const module = await moduleLoader();
  expect(module.createApp).toBeTypeOf("function");
  if (!module.createApp) return undefined;
  return module.createApp();
}

async function sourceRequest(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    testEnv,
  );
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("source management API", () => {
  it("requires_authentication_for_source_routes", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await app.request("/v1/sources", {}, testEnv);

    expect(response.status).toBe(401);
  });

  it("authenticates_verified_service_tokens_and_rate_limits_each_identity_separately", async () => {
    const app = await loadApp();
    if (!app) return;
    const keys: string[] = [];
    const rateLimiter: RateLimit = {
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    };
    const productionEnv = { ...testEnv, APP_ENV: "production" as const, ACCESS_AUD: "expected-aud", RATE_LIMITER: rateLimiter };
    const serviceRequest = (serviceTokenId: string) => app.request("/v1/sources", {}, productionEnv, {
      access: {
        aud: "expected-aud",
        getIdentity: async () => ({ service_token_id: serviceTokenId, service_token_status: true }),
      },
    });

    expect((await serviceRequest("service-a.access")).status).toBe(200);
    expect((await serviceRequest("service-b.access")).status).toBe(200);

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.join(" ")).not.toContain("service-a.access");
    expect(keys.join(" ")).not.toContain("service-b.access");
  });

  const rejectionCases: Array<{ name: string; headers: Record<string, string>; executionCtx?: AccessExecutionContext }> = [
    { name: "no native context despite forged headers", headers: { Authorization: "Bearer forged", "Cf-Access-Jwt-Assertion": "forged.jwt.assertion" }, executionCtx: undefined },
    { name: "missing audience", headers: {}, executionCtx: { access: { aud: "", getIdentity: async () => ({ service_token_id: "service-a.access", service_token_status: true }) } } },
    { name: "wrong audience", headers: {}, executionCtx: { access: { aud: "wrong-aud", getIdentity: async () => ({ service_token_id: "service-a.access", service_token_status: true }) } } },
    { name: "absent identity", headers: {}, executionCtx: { access: { aud: "expected-aud", getIdentity: async () => undefined } } },
    { name: "user identity without service token status", headers: {}, executionCtx: { access: { aud: "expected-aud", getIdentity: async () => ({ email: "user@example.com", service_token_id: "service-a.access" }) } } },
    { name: "missing service token ID", headers: {}, executionCtx: { access: { aud: "expected-aud", getIdentity: async () => ({ service_token_status: true }) } } },
    { name: "blank service token ID", headers: {}, executionCtx: { access: { aud: "expected-aud", getIdentity: async () => ({ service_token_id: " ", service_token_status: true }) } } },
    { name: "identity lookup throws", headers: {}, executionCtx: { access: { aud: "expected-aud", getIdentity: async () => { throw new Error("identity lookup failed"); } } } },
  ];

  it.each(rejectionCases)("rejects $name before rate limiting without echoing auth material", async ({ headers, executionCtx }) => {
    const app = await loadApp();
    if (!app) return;
    let limiterCalls = 0;
    const productionEnv = {
      ...testEnv,
      APP_ENV: "production" as const,
      ACCESS_AUD: "expected-aud",
      RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    };
    const response = await app.request("/v1/sources", { headers }, productionEnv, executionCtx);

    expect(response.status).toBe(401);
    expect(limiterCalls).toBe(0);
    const body = await response.text();
    expect(body).not.toContain("forged.jwt.assertion");
    expect(body).not.toContain("service-a.access");
  });

  it("rejects_production_requests_when_ACCESS_AUD_is_missing", async () => {
    const app = await loadApp();
    if (!app) return;
    let limiterCalls = 0;
    const response = await app.request("/v1/sources", {}, {
      ...testEnv,
      APP_ENV: "production" as const,
      RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    }, {
      access: {
        aud: "expected-aud",
        getIdentity: async () => ({ service_token_id: "service-a.access", service_token_status: true }),
      },
    });

    expect(response.status).toBe(401);
    expect(limiterCalls).toBe(0);
  });

  it("creates_lists_updates_and_soft_disables_a_source", async () => {
    const app = await loadApp();
    if (!app) return;

    const createdResponse = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed",
      url: "https://example.com/rss.xml",
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ source: Record<string, unknown> }>();
    expect(created.source).toMatchObject({ kind: "feed", url: "https://example.com/rss.xml", poll_interval_sec: 7200, enabled: true });

    const listedResponse = await sourceRequest(app, "/v1/sources");
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json<{ sources: Array<Record<string, unknown>> }>();
    expect(listed.sources).toHaveLength(1);
    expect(listed.sources[0].id).toBe(created.source.id);

    const updatedResponse = await sourceRequest(app, `/v1/sources/${created.source.id}`, "PATCH", {
      poll_interval_sec: 900,
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json<{ source: Record<string, unknown> }>();
    expect(updated.source.poll_interval_sec).toBe(900);

    const disabledResponse = await sourceRequest(app, `/v1/sources/${created.source.id}`, "DELETE");
    expect(disabledResponse.status).toBe(200);
    const disabled = await disabledResponse.json<{ source: Record<string, unknown> }>();
    expect(disabled.source.enabled).toBe(false);
  });

  it("exposes_per_source_pending_backlog_and_global_storage_status", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/backlog-visible.xml",
    });
    const source = await created.json<{ source: { id: string } }>();
    const disabledCreated = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/disabled-backlog-visible.xml",
    });
    const disabledSource = await disabledCreated.json<{ source: { id: string } }>();
    await sourceRequest(app, `/v1/sources/${disabledSource.source.id}`, "DELETE");
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at)
      VALUES ('backlog-visible-1', ?, 'article', 'backlog-1', 'https://example.com/backlog-1', 'pending', ?)
    `).bind(source.source.id, now - 120).run();
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, discovered_at)
      VALUES ('backlog-disabled-1', ?, 'article', 'disabled-backlog-1', 'https://example.com/disabled-backlog-1', 'pending', ?)
    `).bind(disabledSource.source.id, now - 300).run();
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();

    const listed = await sourceRequest(app, "/v1/sources");
    const status = await sourceRequest(app, "/v1/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      pending: { active_count: 1, disabled_count: 1, oldest_age_seconds: expect.any(Number) },
      storage: { observed_db_size: expect.any(Number), state: expect.any(String) },
    });

    const listedPayload = await listed.json<{ sources: Array<Record<string, unknown>> }>();
    expect(listedPayload.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: source.source.id, pending_count: 1, oldest_pending_at: now - 120 }),
      expect.objectContaining({ id: disabledSource.source.id, pending_count: 1, oldest_pending_at: now - 300, last_status: "disabled_source" }),
    ]));
    expect(status.status).toBe(200);
  });

  it("patching_other_fields_does_not_reenable_a_disabled_source", async () => {
    const app = await loadApp();
    if (!app) return;

    const createdResponse = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed",
      url: "https://example.com/rss.xml",
    });
    const created = await createdResponse.json<{ source: Record<string, unknown> }>();
    await sourceRequest(app, `/v1/sources/${created.source.id}`, "DELETE");

    const response = await sourceRequest(app, `/v1/sources/${created.source.id}`, "PATCH", {
      poll_interval_sec: 900,
    });

    expect(response.status).toBe(200);
    const updated = await response.json<{ source: Record<string, unknown> }>();
    expect(updated.source).toMatchObject({ enabled: false, poll_interval_sec: 900 });
  });

  it("rejects_a_null_poll_interval_instead_of_treating_it_as_missing", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/null-interval.xml",
    });
    const source = await created.json<{ source: { id: string } }>();

    const response = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { poll_interval_sec: null });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_source_update" } });
    expect(await testEnv.DB.prepare("SELECT poll_interval_sec FROM sources WHERE id = ?").bind(source.source.id).first())
      .toEqual({ poll_interval_sec: 7200 });
  });

  it("clears_disabled_source_status_when_the_source_is_reenabled", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/re-enable.xml",
    });
    const source = await created.json<{ source: { id: string } }>();
    await sourceRequest(app, `/v1/sources/${source.source.id}`, "DELETE");

    const response = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { enabled: true });
    const updated = await response.json<{ source: { enabled: boolean; last_status: string | null } }>();

    expect(response.status).toBe(200);
    expect(updated.source).toMatchObject({ enabled: true, last_status: null });
  });

  it("allows_disabling_a_legacy_html_list_source_without_itemLink", async () => {
    const app = await loadApp();
    if (!app) return;
    await testEnv.DB.prepare(`
      INSERT INTO sources (id, url, kind, host, selectors_json)
      VALUES ('legacy-list', 'https://example.com/news/', 'html_list', 'example.com', '{"title":"h1","body":"article"}')
    `).run();

    const response = await sourceRequest(app, "/v1/sources/legacy-list", "PATCH", { enabled: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: { id: "legacy-list", enabled: false } });
  });

  it("rejects_new_sources_when_physical_storage_is_limited", async () => {
    const app = await loadApp();
    if (!app) return;
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();

    const response = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/storage-limited-feed",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "storage_limit" } });
    expect(await testEnv.DB.prepare("SELECT id FROM sources WHERE url = 'https://example.com/storage-limited-feed'").first()).toBeNull();
  });

  it("rejects_new_sources_while_an_export_lock_is_active", async () => {
    const app = await loadApp();
    if (!app) return;
    await testEnv.DB.prepare("UPDATE system_state SET export_lock = 1, export_lock_id = 'export-1', export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(Math.floor(Date.now() / 1000) + 600).run();

    const response = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/export-locked-feed",
    });

    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error: { code: "export_in_progress" } });
    expect(await testEnv.DB.prepare("SELECT id FROM sources WHERE url = 'https://example.com/export-locked-feed'").first()).toBeNull();
  });

  it("prevents_a_source_insert_if_an_export_lock_starts_after_the_route_check", async () => {
    await testEnv.DB.prepare("UPDATE system_state SET export_lock = 1, export_lock_id = 'export-race', export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(Math.floor(Date.now() / 1000) + 600).run();

    await expect(createSource(testEnv.DB, {
      kind: "feed",
      url: "https://example.com/export-race-feed",
      poll_interval_sec: 7200,
    })).rejects.toMatchObject({ status: 423, code: "export_in_progress" });
    expect(await testEnv.DB.prepare("SELECT id FROM sources WHERE url = 'https://example.com/export-race-feed'").first()).toBeNull();
  });

  it("blocks_all_source_mutations_during_export", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/export-update-feed",
    });
    const source = await created.json<{ source: { id: string } }>();
    await testEnv.DB.prepare("UPDATE system_state SET export_lock = 1, export_lock_id = 'export-1', export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(Math.floor(Date.now() / 1000) + 600).run();

    const patched = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { poll_interval_sec: 900 });
    const disabledPatch = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { enabled: false });
    const disabled = await sourceRequest(app, `/v1/sources/${source.source.id}`, "DELETE");

    expect(patched.status).toBe(423);
    expect(disabledPatch.status).toBe(423);
    expect(disabled.status).toBe(423);
    expect(await testEnv.DB.prepare("SELECT enabled, poll_interval_sec FROM sources WHERE id = ?").bind(source.source.id).first())
      .toMatchObject({ enabled: 1, poll_interval_sec: 7200 });
  });

  it("allows_source_disable_while_physical_storage_is_limited", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/storage-disable-feed",
    });
    const source = await created.json<{ source: { id: string } }>();
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'read_only' WHERE singleton_id = 'global'")
      .bind(300 * 1024 * 1024).run();

    const disabled = await sourceRequest(app, `/v1/sources/${source.source.id}`, "DELETE");

    expect(disabled.status).toBe(200);
    expect(await testEnv.DB.prepare("SELECT enabled FROM sources WHERE id = ?").bind(source.source.id).first())
      .toMatchObject({ enabled: 0 });
  });

  it("allows_patch_disable_but_not_other_source_edits_in_read_only_storage_state", async () => {
    const app = await loadApp();
    if (!app) return;
    const created = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "feed", url: "https://example.com/read-only-feed",
    });
    const source = await created.json<{ source: { id: string } }>();
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'read_only' WHERE singleton_id = 'global'")
      .bind(300 * 1024 * 1024).run();

    const changedInterval = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { poll_interval_sec: 900 });
    const disabled = await sourceRequest(app, `/v1/sources/${source.source.id}`, "PATCH", { enabled: false });

    expect(changedInterval.status).toBe(503);
    expect(disabled.status).toBe(200);
    expect(await testEnv.DB.prepare("SELECT enabled, poll_interval_sec FROM sources WHERE id = ?").bind(source.source.id).first())
      .toMatchObject({ enabled: 0, poll_interval_sec: 7200 });
  });

  it("caps_active_sources_at_100", async () => {
    const app = await loadApp();
    if (!app) return;

    const responses: Response[] = [];
    for (let index = 0; index < 101; index += 1) {
      responses.push(await sourceRequest(app, "/v1/sources", "POST", {
        kind: "feed",
        url: `https://example.com/feed/${index}`,
      }));
    }

    expect(responses.slice(0, 100).every((response) => response.status === 201)).toBe(true);
    expect(responses[100].status).toBe(409);
    expect(await responses[100].json()).toMatchObject({ error: { code: "source_limit_reached" } });
  });

  it("rejects_request_bodies_over_32_KiB", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await sourceRequest(app, "/v1/sources", "POST", {
      kind: "html_list",
      url: "https://example.com/news",
      selectors: { title: "h1", body: "x".repeat(33_000) },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
  });

  it.each([
    { operation: "listSources", method: "GET", path: "/v1/sources" },
    { operation: "getSource", method: "PATCH", path: "/v1/sources/test-source", body: { poll_interval_sec: 900 } },
    { operation: "disableSource", method: "DELETE", path: "/v1/sources/test-source" },
  ])("returns_a_generic_JSON_500_for_$operation", async ({ method, path, body }) => {
    const app = await loadApp();
    if (!app) return;

    const sensitiveD1Error = "D1 internal details: account-secret-987 and SQL trace";
    const statement: Record<string, unknown> = {};
    statement.bind = () => statement;
    statement.all = async () => { throw new Error(sensitiveD1Error); };
    statement.first = async () => { throw new Error(sensitiveD1Error); };
    const failingDb = {
      prepare: () => statement,
    } as unknown as D1Database;
    const failureEnv = { ...testEnv, DB: failingDb };
    const headers = new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` });
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const response = await app.request(
      path,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      failureEnv,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const payload = await response.json<{ error: { code: string; message: string; request_id: string } }>();
    expect(payload).toMatchObject({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(payload.error.request_id).toBeTypeOf("string");
    expect(JSON.stringify(payload)).not.toContain(sensitiveD1Error);
  });
});
