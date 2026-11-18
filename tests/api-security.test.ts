import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN: string;
  RATE_LIMITER: RateLimit;
  TEST_MIGRATIONS: D1Migration[];
}

interface ApiAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const apiToken = "api-security-test-token";
const testEnv: TestEnvironment = {
  ...runtimeEnv,
  API_TOKEN: apiToken,
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<ApiAppModule>("../src/app.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;

  const module = await moduleLoader();
  expect(module.createApp).toBeTypeOf("function");
  if (!module.createApp) return undefined;
  return module.createApp();
}

async function apiRequest(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  options: { token?: string; includeAuthorization?: boolean } = {},
  requestEnv = testEnv,
): Promise<Response> {
  const headers = new Headers();
  if (options.includeAuthorization !== false) {
    headers.set("Authorization", `Bearer ${options.token ?? apiToken}`);
  }
  return await app.request(path, { headers }, requestEnv);
}

async function expectNoStoreAndNoToken(response: Response): Promise<void> {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const responseText = await response.clone().text();
  const responseHeaders: string[] = [];
  response.headers.forEach((value, name) => responseHeaders.push(`${name}: ${value}`));
  expect(`${responseText}\n${responseHeaders.join("\n")}`).not.toContain(apiToken);
}

async function expectApiError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const payload = await response.clone().json<{ error: { code: string; message: string; request_id: string } }>();
  expect(payload.error).toMatchObject({ code, message: expect.any(String), request_id: expect.any(String) });
  expect(payload.error.request_id.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("private API response security", () => {
  it("marks_an_authenticated_API_success_as_non_cacheable", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await apiRequest(app, "/v1/status");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expectNoStoreAndNoToken(response);
  });

  it("marks_an_authenticated_API_not_found_as_non_cacheable", async () => {
    const app = await loadApp();
    if (!app) return;

    const response = await apiRequest(app, "/v1/not-a-real-endpoint");

    expect(response.status).toBe(404);
    await expectNoStoreAndNoToken(response);
  });

  it("marks_validation_errors_as_non_cacheable", async () => {
    const app = await loadApp();
    if (!app) return;

    const headers = new Headers({
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    });
    const response = await app.request("/v1/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }, testEnv);

    await expectApiError(response, 400, "invalid_source_kind");
    await expectNoStoreAndNoToken(response);
  });

  it.each([
    ["missing", { includeAuthorization: false }],
    ["wrong", { token: "incorrect-token" }],
  ] as const)("marks_a_%s_token_response_as_non_cacheable", async (_name, options) => {
    const app = await loadApp();
    if (!app) return;

    const response = await apiRequest(app, "/v1/status", options);

    await expectApiError(response, 401, "unauthorized");
    await expectNoStoreAndNoToken(response);
  });

  it("marks_rate_limit_rejections_as_non_cacheable", async () => {
    const app = await loadApp();
    if (!app) return;
    const limitedEnv: TestEnvironment = {
      ...testEnv,
      RATE_LIMITER: { limit: async () => ({ success: false }) },
    };

    const response = await apiRequest(app, "/v1/status", {}, limitedEnv);

    await expectApiError(response, 429, "rate_limit_exceeded");
    await expectNoStoreAndNoToken(response);
  });

  it("marks_rate_limiter_failures_as_non_cacheable", async () => {
    const app = await loadApp();
    if (!app) return;
    const unavailableEnv: TestEnvironment = {
      ...testEnv,
      RATE_LIMITER: { limit: async () => { throw new Error("limiter unavailable"); } },
    };

    const response = await apiRequest(app, "/v1/status", {}, unavailableEnv);

    await expectApiError(response, 503, "rate_limiter_unavailable");
    await expectNoStoreAndNoToken(response);
  });

  it("marks_handled_internal_errors_as_non_cacheable_without_leaking_secrets", async () => {
    const app = await loadApp();
    if (!app) return;
    const sensitiveError = "private database failure secret-value-123";
    const failingStatement: Record<string, unknown> = {};
    failingStatement.first = async () => { throw new Error(sensitiveError); };
    const failingDb = { prepare: () => failingStatement } as unknown as D1Database;
    const failureEnv = { ...testEnv, DB: failingDb };

    const response = await apiRequest(app, "/v1/status", {}, failureEnv);

    await expectApiError(response, 500, "internal_error");
    await expectNoStoreAndNoToken(response);
    expect(await response.clone().text()).not.toContain(sensitiveError);
  });
});
