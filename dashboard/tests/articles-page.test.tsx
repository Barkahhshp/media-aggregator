import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider, TokenSession } from "../src/auth/AuthProvider";
import { ArticlesPage } from "../src/pages/ArticlesPage";

function createSession() {
  const session = new TokenSession();
  session.login("task-11-test-token");
  return session;
}

function articleFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    source_id: "source-1",
    external_id: "external-1",
    canonical_url: "https://publisher.example.test/story",
    title: "A stored story",
    summary: "A short summary",
    author: "Ada Writer",
    published_at: "2025-02-03T12:00:00.000Z",
    fetched_at: 1_738_598_400,
    content_hash: "hash-1",
    status: "stored",
    created_at: 1_738_598_400,
    updated_at: 1_738_598_400,
    ...overrides,
  };
}

function sourceFixture() {
  return {
    id: "source-1",
    url: "https://publisher.example.test/feed?token=private-source-query",
    host: "publisher.example.test",
    kind: "feed",
    poll_interval_sec: 3_600,
    selectors: null,
    enabled: true,
    next_fetch_at: 2_000_000_000,
    consecutive_errors: 0,
    last_status: "succeeded",
    last_fetched_at: 1_738_598_400,
    created_at: 1_738_598_400,
    updated_at: 1_738_598_400,
    pending_count: 0,
    oldest_pending_at: null,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function emptyOverview() {
  return {
    storage: { state: "normal", observed_db_size: 0, warning_threshold_bytes: 280 * 1_048_576, hard_stop_threshold_bytes: 300 * 1_048_576 },
    pending: { active_count: 0, disabled_count: 0, oldest_age_seconds: null, by_status: { active: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 }, disabled: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 } } },
    sources: { enabled_count: 1, disabled_count: 0, overdue_count: 0 },
    runs_24h: { running: 0, succeeded: 0, partial: 0, failed: 0, blocked: 0, storage_limit: 0 },
    latest_run: null,
  };
}

describe("Articles page", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("serializes supported source, inclusive date range, search, and limit parameters", async () => {
    const articleRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [sourceFixture()] });
      articleRequests.push(url.toString());
      return jsonResponse({ articles: [], next_cursor: null });
    }));

    render(<ArticlesPage session={createSession()} />);
    await screen.findByRole("heading", { name: "Articles / Feed" });
    await screen.findByRole("option", { name: /publisher\.example\.test/i });
    fireEvent.change(screen.getByLabelText(/source/i), { target: { value: "source-1" } });
    fireEvent.change(screen.getByLabelText(/from date/i), { target: { value: "2025-02-01" } });
    fireEvent.change(screen.getByLabelText(/to date/i), { target: { value: "2025-02-03" } });
    fireEvent.change(screen.getByLabelText(/search titles and summaries/i), { target: { value: "  climate report  " } });
    fireEvent.change(screen.getByLabelText(/articles per page/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() => expect(articleRequests.length).toBe(2));
    const params = new URL(articleRequests[1]!).searchParams;
    expect(params.get("source_id")).toBe("source-1");
    expect(params.get("from")).toBe(new Date(2025, 1, 1).toISOString());
    expect(params.get("to")).toBe(new Date(2025, 1, 4).toISOString());
    expect(params.get("q")).toBe("climate report");
    expect(params.get("limit")).toBe("50");
    expect(params.has("cursor")).toBe(false);
    expect(document.body.textContent).not.toContain("private-source-query");
  });

  it("uses opaque cursors for next and previous-page navigation", async () => {
    const opaqueCursor = "opaque+/cursor==";
    const articleRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      articleRequests.push(url);
      if (url.searchParams.has("cursor")) {
        return jsonResponse({ articles: [articleFixture({ id: "article-2", title: "Second page story" })], next_cursor: "opaque-next-cursor" });
      }
      if (articleRequests.length === 1) {
        return jsonResponse({ articles: [articleFixture({ title: "First page story" })], next_cursor: opaqueCursor });
      }
      return jsonResponse({ articles: [articleFixture({ title: "First page story" })], next_cursor: opaqueCursor });
    }));

    render(<ArticlesPage session={createSession()} />);
    expect(await screen.findByText("First page story")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));

    expect(await screen.findByText("Second page story")).toBeTruthy();
    expect(articleRequests[1]?.searchParams.get("cursor")).toBe(opaqueCursor);
    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));

    expect(await screen.findByText("First page story")).toBeTruthy();
    expect(articleRequests[2]?.searchParams.has("cursor")).toBe(false);
  });

  it("shows a clear empty state and handles articles without a publication date", async () => {
    let articles: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      return jsonResponse({ articles, next_cursor: null });
    }));

    const view = render(<ArticlesPage session={createSession()} />);
    expect(await screen.findByText(/no articles match these filters/i)).toBeTruthy();
    articles = [articleFixture({ published_at: null, title: "Undated article" })];
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    expect(await screen.findByText("Undated article")).toBeTruthy();
    expect(screen.getByText(/date unavailable/i)).toBeTruthy();
    view.unmount();
  });

  it("shows a retryable API error for the article list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      return jsonResponse({ error: { code: "internal_error", message: "Article feed unavailable", request_id: "req-11" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ArticlesPage session={createSession()} />);
    expect(await screen.findByText("Article feed unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("opens the Articles/Feed screen from the application navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/overview") return jsonResponse(emptyOverview());
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      return jsonResponse({ articles: [], next_cursor: null });
    }));

    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: "task-11-app-token" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("link", { name: /articles\/feed/i }));

    expect(await screen.findByRole("heading", { name: "Articles / Feed" })).toBeTruthy();
    expect(screen.getByText(/search covers article titles and summaries, not full article bodies/i)).toBeTruthy();
    expect(window.location.pathname).toBe("/articles");
  });
});
