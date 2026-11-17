import { describe, expect, it } from "vitest";

interface AuthEnvironment {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN?: string;
  ACCESS_AUD?: string;
}

interface LocalTokenModule {
  authenticateLocal(request: Request, env: AuthEnvironment): Response | null;
}

const authModules = import.meta.glob<LocalTokenModule>("../src/auth/local-token.ts");

async function loadAuthenticateLocal() {
  const moduleLoader = authModules["../src/auth/local-token.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;

  const module = await moduleLoader();
  expect(module.authenticateLocal).toBeTypeOf("function");
  return module.authenticateLocal;
}

const localEnv: AuthEnvironment = {
  DB: {} as D1Database,
  APP_ENV: "test",
  API_TOKEN: "test-secret-token",
};

describe("local authentication", () => {
  it("rejects_requests_without_a_local_bearer_token", async () => {
    const authenticateLocal = await loadAuthenticateLocal();
    if (!authenticateLocal) return;

    const response = await authenticateLocal(new Request("https://api.example/v1/sources"), localEnv);

    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("rejects_a_wrong_local_bearer_token_without_leaking_the_secret", async () => {
    const authenticateLocal = await loadAuthenticateLocal();
    if (!authenticateLocal) return;

    const request = new Request("https://api.example/v1/sources", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const response = await authenticateLocal(request, localEnv);

    expect(response?.status).toBe(401);
    expect(await response?.text()).not.toContain(localEnv.API_TOKEN);
  });

  it("accepts_the_configured_local_bearer_token", async () => {
    const authenticateLocal = await loadAuthenticateLocal();
    if (!authenticateLocal) return;

    const request = new Request("https://api.example/v1/sources", {
      headers: { Authorization: `Bearer ${localEnv.API_TOKEN}` },
    });

    await expect(authenticateLocal(request, localEnv)).resolves.toBeNull();
  });

  it("does_not_use_API_TOKEN_as_a_production_access_fallback", async () => {
    const authenticateLocal = await loadAuthenticateLocal();
    if (!authenticateLocal) return;

    const productionEnv: AuthEnvironment = { ...localEnv, APP_ENV: "production" };
    const response = await authenticateLocal(
      new Request("https://api.example/v1/sources", {
        headers: { Authorization: `Bearer ${localEnv.API_TOKEN}` },
      }),
      productionEnv,
    );

    expect(response?.status).toBe(401);
  });

  it("rejects_production_authentication_without_native_access_context", async () => {
    const authenticateLocal = await loadAuthenticateLocal();
    if (!authenticateLocal) return;

    const productionEnv: AuthEnvironment = { ...localEnv, APP_ENV: "production" };
    const request = new Request("https://api.example/v1/sources", { headers: { "Cf-Access-Jwt-Assertion": "signed-access-assertion" } });

    await expect(authenticateLocal(request, productionEnv)).resolves.not.toBeNull();
  });
});
