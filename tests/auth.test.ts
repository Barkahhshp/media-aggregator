import { describe, expect, it } from "vitest";

interface AuthEnvironment {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN?: string;
}

interface LocalTokenModule {
  authenticateLocal(request: Request, env: AuthEnvironment): Promise<Response | null>;
  rateLimitKey(request: Request, env: AuthEnvironment): Promise<string | null>;
}

const authModules = import.meta.glob<LocalTokenModule>("../src/auth/local-token.ts");

async function loadAuthModule() {
  const moduleLoader = authModules["../src/auth/local-token.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  return await moduleLoader();
}

const localEnv: AuthEnvironment = {
  DB: {} as D1Database,
  APP_ENV: "test",
  API_TOKEN: "test-secret-token",
};

describe("local authentication", () => {
  it("rejects_requests_without_a_local_bearer_token", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    const response = await module.authenticateLocal(new Request("https://api.example/v1/sources"), localEnv);
    expect(response?.status).toBe(401);
  });

  it("rejects_a_wrong_local_bearer_token_without_leaking_the_secret", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    const response = await module.authenticateLocal(new Request("https://api.example/v1/sources", {
      headers: { Authorization: "Bearer wrong-token" },
    }), localEnv);
    expect(response?.status).toBe(401);
    expect(await response?.text()).not.toContain(localEnv.API_TOKEN);
  });

  it("accepts_the_configured_local_bearer_token", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    await expect(module.authenticateLocal(new Request("https://api.example/v1/sources", {
      headers: { Authorization: `Bearer ${localEnv.API_TOKEN}` },
    }), localEnv)).resolves.toBeNull();
  });

  it("accepts_the_configured_production_bearer_token", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    const productionEnv = { ...localEnv, APP_ENV: "production" as const };
    await expect(module.authenticateLocal(new Request("https://api.example/v1/sources", {
      headers: { Authorization: `Bearer ${localEnv.API_TOKEN}` },
    }), productionEnv)).resolves.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["wrong", "wrong-token"],
    ["malformed", "one two"],
  ])("rejects_%s_production_bearer_token", async (_name, token) => {
    const module = await loadAuthModule();
    if (!module) return;
    const productionEnv = { ...localEnv, APP_ENV: "production" as const };
    const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
    const response = await module.authenticateLocal(new Request("https://api.example/v1/sources", { headers }), productionEnv);
    expect(response?.status).toBe(401);
  });

  it("fails_closed_when_production_token_configuration_is_absent", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    const productionEnv: AuthEnvironment = { APP_ENV: "production", DB: {} as D1Database };
    const response = await module.authenticateLocal(new Request("https://api.example/v1/sources", {
      headers: { Authorization: "Bearer any-token" },
    }), productionEnv);
    expect(response?.status).toBe(401);
  });

  it("uses_a_stable_sha256_hash_of_the_authenticated_token_as_the_limiter_key", async () => {
    const module = await loadAuthModule();
    if (!module) return;
    const request = new Request("https://api.example/v1/sources", {
      headers: { Authorization: `Bearer ${localEnv.API_TOKEN}` },
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(localEnv.API_TOKEN!));
    const expectedHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await expect(module.rateLimitKey(request, localEnv)).resolves.toBe(`test:${expectedHash}`);
    await expect(module.rateLimitKey(request, localEnv)).resolves.toBe(`test:${expectedHash}`);
  });
});
