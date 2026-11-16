import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test";
  API_TOKEN: string;
  TEST_MIGRATIONS: D1Migration[];
}

interface SourcesAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = { ...runtimeEnv, API_TOKEN: "local-test-token" };
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
});
