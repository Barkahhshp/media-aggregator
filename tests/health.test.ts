import { describe, expect, it } from "vitest";

interface HealthAppModule {
  createApp(): {
    request(
      input: string,
      init: RequestInit,
      env: { DB: D1Database; APP_ENV: "test"; API_TOKEN: string },
    ): Promise<Response>;
  };
}

const appModules = import.meta.glob<HealthAppModule>("../src/app.ts");

describe("health route", () => {
  it("health_returns_minimal_json_without_secrets", async () => {
    const appModuleLoader = appModules["../src/app.ts"];
    expect(appModuleLoader).toBeDefined();
    if (!appModuleLoader) return;

    const { createApp } = await appModuleLoader();
    const secret = "test-token-that-must-not-leak";
    const response = await createApp().request(
      "/health",
      {},
      { DB: {} as D1Database, APP_ENV: "test", API_TOKEN: secret },
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["service", "status"]);
    expect(body).toEqual({ status: "ok", service: "media-aggregator" });
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});
