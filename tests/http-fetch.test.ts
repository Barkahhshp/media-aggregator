import { afterEach, describe, expect, it, vi } from "vitest";

interface FetchLimits {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

interface FetchResult {
  url: URL;
  status: number;
  headers: Headers;
  body: string;
  bytes: number;
}

interface HttpFetchModule {
  fetchPublicUrl(url: URL, sourceHost: string, limits: FetchLimits): Promise<FetchResult>;
}

const fetchModules = import.meta.glob<HttpFetchModule>("../src/ingest/http-fetch.ts");

async function loadFetchPublicUrl() {
  const moduleLoader = fetchModules["../src/ingest/http-fetch.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.fetchPublicUrl).toBeTypeOf("function");
  return module.fetchPublicUrl;
}

afterEach(() => vi.unstubAllGlobals());

describe("safe HTTP fetch", () => {
  it("follows_up_to_three_manual_same_host_redirects", async () => {
    const fetchPublicUrl = await loadFetchPublicUrl();
    if (!fetchPublicUrl) return;

    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const replies = [
      new Response(null, { status: 302, headers: { Location: "/step-1" } }),
      new Response(null, { status: 301, headers: { Location: "/step-2" } }),
      new Response(null, { status: 307, headers: { Location: "/final" } }),
      new Response("complete", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return replies[calls.length - 1];
    }));

    const result = await fetchPublicUrl(new URL("https://example.com/start"), "example.com", {});

    expect(result.body).toBe("complete");
    expect(result.url.href).toBe("https://example.com/final");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
  });

  it("rejects_a_cross_host_redirect_before_fetching_the_target", async () => {
    const fetchPublicUrl = await loadFetchPublicUrl();
    if (!fetchPublicUrl) return;

    const calls: Array<RequestInfo | URL> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input);
      return new Response(null, { status: 302, headers: { Location: "https://attacker.com/payload" } });
    }));

    await expect(fetchPublicUrl(new URL("https://example.com/feed"), "example.com", {})).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("rejects_more_than_three_redirect_hops", async () => {
    const fetchPublicUrl = await loadFetchPublicUrl();
    if (!fetchPublicUrl) return;

    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { Location: `/hop-${calls}` } });
    }));

    await expect(fetchPublicUrl(new URL("https://example.com/start"), "example.com", {})).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("rejects_a_response_that_exceeds_2_MiB_after_streaming", async () => {
    const fetchPublicUrl = await loadFetchPublicUrl();
    if (!fetchPublicUrl) return;

    const body = new Uint8Array(2 * 1024 * 1024 + 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(fetchPublicUrl(new URL("https://example.com/large"), "example.com", {})).rejects.toThrow();
  });

  it("aborts_a_fetch_after_the_configured_timeout", async () => {
    const fetchPublicUrl = await loadFetchPublicUrl();
    if (!fetchPublicUrl) return;

    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    await expect(
      fetchPublicUrl(new URL("https://example.com/slow"), "example.com", { timeoutMs: 10 }),
    ).rejects.toThrow();
  });
});
