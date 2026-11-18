import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenSession } from "../src/auth/AuthProvider";
import { apiRequest } from "../src/api/client";

function createSession(token = "task-9-test-token") {
  const session = new TokenSession();
  session.login(token);
  return session;
}

describe("dashboard API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a same-origin request with a Bearer header and no-store cache", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiRequest(createSession(), "/v1/status");

    expect(response.status).toBe(200);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/v1/status");
    expect(new URL(String(input), window.location.origin).origin).toBe(window.location.origin);
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer task-9-test-token");
    expect(String(input)).not.toContain("task-9-test-token");
  });

  it("refuses cross-origin request URLs", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest(createSession(), "https://attacker.example/v1/status"))
      .rejects.toThrow(/same-origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the in-memory token when the API returns 401", async () => {
    const session = createSession();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));

    const response = await apiRequest(session, "/v1/private");

    expect(response.status).toBe(401);
    expect(session.getToken()).toBeNull();
  });
});
