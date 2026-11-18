import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const API_TOKEN = "task-9-test-token";
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function bindings(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: () => { throw new Error("database failure must not be returned"); } } as unknown as D1Database,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    APP_ENV: "test",
    API_TOKEN,
    ...overrides,
  };
}

function expectSecurityHeaders(response: Response) {
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
}

describe("Worker dashboard security and asset routing", () => {
  it("serves SPA HTML from ASSETS with security headers and no-store", async () => {
    const assetFetch = vi.fn(async () => new Response("<!doctype html><title>dashboard</title>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
    const response = await worker.fetch(
      new Request("https://dashboard.example/sources"),
      bindings({ ASSETS: { fetch: assetFetch } as unknown as Fetcher }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("dashboard");
    expect(assetFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(response);
  });

  it("keeps unknown /v1 paths on the authenticated API and does not fall through to SPA assets", async () => {
    const assetFetch = vi.fn(async () => new Response("SPA fallback", {
      headers: { "Content-Type": "text/html" },
    }));
    const response = await worker.fetch(
      new Request("https://dashboard.example/v1/unknown", {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
      bindings({ ASSETS: { fetch: assetFetch } as unknown as Fetcher }),
      context,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("SPA fallback");
    expect(assetFetch).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("adds security headers to API authentication failures and handled errors", async () => {
    const missingToken = await worker.fetch(
      new Request("https://dashboard.example/v1/status"),
      bindings(),
      context,
    );
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(missingToken);

    const failed = await worker.fetch(
      new Request("https://dashboard.example/v1/status", {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
      bindings(),
      context,
    );
    expect(failed.status).toBe(500);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.text()).not.toContain("database failure must not be returned");
    expectSecurityHeaders(failed);
  });

  it("keeps non-GET requests to /health on the Worker instead of the SPA fallback", async () => {
    const assetFetch = vi.fn(async () => new Response("SPA fallback", {
      headers: { "Content-Type": "text/html" },
    }));
    const response = await worker.fetch(
      new Request("https://dashboard.example/health", { method: "POST" }),
      bindings({ ASSETS: { fetch: assetFetch } as unknown as Fetcher }),
      context,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("SPA fallback");
    expect(assetFetch).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("keeps API routing usable when no static asset binding is present", async () => {
    const response = await worker.fetch(
      new Request("https://dashboard.example/health"),
      bindings(),
      context,
    );

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });
});
