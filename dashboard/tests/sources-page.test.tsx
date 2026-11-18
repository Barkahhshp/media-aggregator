import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider } from "../src/auth/AuthProvider";
import { TokenSession } from "../src/auth/AuthProvider";
import { SourcesPage } from "../src/pages/SourcesPage";

function createSession() {
  const session = new TokenSession();
  session.login("task-10-test-token");
  return session;
}

function sourceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-123",
    url: "https://feed.example.test/rss?api_key=do-not-render-this",
    host: "feed.example.test",
    kind: "feed",
    poll_interval_sec: 3_600,
    selectors: null,
    enabled: true,
    next_fetch_at: 1,
    etag: null,
    last_modified: null,
    feed_watermark: null,
    sitemap_last_loc: null,
    consecutive_errors: 2,
    last_status: "blocked",
    last_fetched_at: 1,
    created_at: 1,
    updated_at: 1,
    pending_count: 3,
    oldest_pending_at: 1,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function methodOf(init?: RequestInit) {
  return init?.method ?? "GET";
}

describe("Sources page", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads source operations and renders host, status explanations, and backlog without exposing full URLs", async () => {
    const sources = [
      sourceFixture(),
      sourceFixture({
        id: "source-disabled",
        host: "paused.example.test",
        url: "https://paused.example.test/feed?token=private-query-secret",
        enabled: false,
        last_status: "disabled_source",
        consecutive_errors: 0,
        pending_count: 2,
      }),
      sourceFixture({
        id: "source-storage",
        host: "storage.example.test",
        url: "https://storage.example.test/feed?token=another-secret",
        last_status: "storage_limit",
        consecutive_errors: 1,
      }),
      sourceFixture({
        id: "source-explicit-error",
        host: "error.example.test",
        url: "https://error.example.test/feed?token=third-secret",
        last_status: "network_error",
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sources })));

    render(<SourcesPage session={createSession()} />);

    expect(await screen.findByText("feed.example.test")).toBeTruthy();
    expect(screen.getByText("paused.example.test")).toBeTruthy();
    expect(screen.getByText(/ID:\s*source-123/u)).toBeTruthy();
    expect(screen.getAllByText(/3\s+items/u).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Backlog").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(0);
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("Disabled source")).toBeTruthy();
    expect(screen.getByText("Storage limit")).toBeTruthy();
    expect(screen.getByText("network_error")).toBeTruthy();
    expect(screen.getByText(/disabled source pauses fetching; its existing backlog is retained/i)).toBeTruthy();
    expect(screen.getByText(/blocked and storage-limit statuses are not empty feeds/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("https://feed.example.test/rss");
    expect(document.body.textContent).not.toContain("do-not-render-this");
    expect(document.body.textContent).not.toContain("private-query-secret");
    expect(document.body.textContent).not.toContain("another-secret");
    expect(document.body.textContent).not.toContain("third-secret");
  });

  it("shows loading, empty, and retryable API error states", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ sources: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<SourcesPage session={createSession()} />);
    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    resolveFetch?.(jsonResponse({ error: { code: "internal_error", message: "Sources are unavailable", request_id: "req-1" } }, 500));

    expect(await screen.findByText("Sources are unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/no sources configured yet/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("sends the supported source-create payload and clears the entered URL after success", async () => {
    const createdSource = sourceFixture({ id: "new-source", host: "new.example.test", url: "https://new.example.test/rss?key=private" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (methodOf(init) === "POST") return jsonResponse({ source: createdSource }, 201);
      return jsonResponse({ sources: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SourcesPage session={createSession()} />);
    await screen.findByText(/no sources configured yet/i);
    fireEvent.click(screen.getByRole("button", { name: /add source/i }));
    fireEvent.change(screen.getByLabelText(/source url/i), { target: { value: "https://new.example.test/rss?key=private" } });
    fireEvent.change(screen.getByLabelText(/poll interval/i), { target: { value: "1800" } });
    fireEvent.click(screen.getByRole("button", { name: /create source/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/v1/sources", expect.objectContaining({ method: "POST" })));
    const [, init] = fetchMock.mock.calls.find(([, request]) => methodOf(request) === "POST") ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "feed",
      url: "https://new.example.test/rss?key=private",
      poll_interval_sec: 1800,
    });
    expect(await screen.findByText("new.example.test")).toBeTruthy();
    expect(screen.queryByDisplayValue("https://new.example.test/rss?key=private")).toBeNull();
  });

  it("sends only interval and selector settings for an existing source update", async () => {
    const articleSource = sourceFixture({
      id: "article-source",
      host: "article.example.test",
      kind: "article",
      selectors: { title: "h1", body: "article", summary: "p" },
      last_status: "succeeded",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (methodOf(init) === "PATCH") return jsonResponse({ source: { ...articleSource, poll_interval_sec: 7_200 } });
      return jsonResponse({ sources: [articleSource] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SourcesPage session={createSession()} />);
    await screen.findByText("article.example.test");
    fireEvent.click(screen.getByRole("button", { name: /edit settings for article.example.test/i }));
    fireEvent.change(screen.getByLabelText(/poll interval/i), { target: { value: "7200" } });
    fireEvent.change(screen.getByLabelText(/selectors json/i), { target: { value: JSON.stringify({ title: "h2", body: "main", summary: "p" }) } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/v1/sources/article-source", expect.objectContaining({ method: "PATCH" })));
    const [, init] = fetchMock.mock.calls.find(([path, request]) => String(path) === "/v1/sources/article-source" && methodOf(request) === "PATCH") ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      poll_interval_sec: 7200,
      selectors: { title: "h2", body: "main", summary: "p" },
    });
  });

  it("disables a source with the existing PATCH contract", async () => {
    const feedSource = sourceFixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (methodOf(init) === "PATCH") return jsonResponse({ source: { ...feedSource, enabled: false, last_status: "disabled_source" } });
      return jsonResponse({ sources: [feedSource] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SourcesPage session={createSession()} />);
    await screen.findByText("feed.example.test");
    fireEvent.click(screen.getByRole("button", { name: /disable feed.example.test/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/v1/sources/source-123", expect.objectContaining({ method: "PATCH" })));
    const [, init] = fetchMock.mock.calls.find(([path, request]) => String(path) === "/v1/sources/source-123" && methodOf(request) === "PATCH") ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
  });

  it("keeps the source actions usable at a narrow mobile viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sources: [sourceFixture()] })));

    render(<SourcesPage session={createSession()} />);

    expect(await screen.findByText("feed.example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add source/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit settings for feed.example.test/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /disable feed.example.test/i })).toBeTruthy();
  });

  it("opens the disabled-backlog source filter when its Overview problem link is selected", async () => {
    const disabledWithBacklog = sourceFixture({ id: "source-disabled", host: "paused.example.test", enabled: false, last_status: "disabled_source", pending_count: 2 });
    const enabledWithBacklog = sourceFixture({ id: "source-enabled", host: "active.example.test", pending_count: 3 });
    const disabledWithoutBacklog = sourceFixture({ id: "source-disabled-empty", host: "empty.example.test", enabled: false, last_status: "disabled_source", pending_count: 0, oldest_pending_at: null });
    const overview = {
      storage: { state: "normal", observed_db_size: 0, warning_threshold_bytes: 280 * 1_048_576, hard_stop_threshold_bytes: 300 * 1_048_576 },
      pending: { active_count: 3, disabled_count: 2, oldest_age_seconds: 30, by_status: { active: { pending: 3, leased: 0, retry_wait: 0, blocked: 0, failed: 0 }, disabled: { pending: 2, leased: 0, retry_wait: 0, blocked: 0, failed: 0 } } },
      sources: { enabled_count: 1, disabled_count: 2, overdue_count: 1 },
      runs_24h: { running: 0, succeeded: 0, partial: 0, failed: 0, blocked: 0, storage_limit: 0 },
      latest_run: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/v1/sources"
      ? jsonResponse({ sources: [disabledWithBacklog, enabledWithBacklog, disabledWithoutBacklog] })
      : jsonResponse(overview));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: "task-10-app-token" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("link", { name: /view disabled-backlog sources/i }));

    expect(await screen.findByText("paused.example.test")).toBeTruthy();
    expect(screen.queryByText("active.example.test")).toBeNull();
    expect(screen.queryByText("empty.example.test")).toBeNull();
    expect(window.location.pathname).toBe("/sources");
    expect(window.location.search).toBe("?filter=backlog&enabled=disabled");
  });
});
