import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider, TokenSession } from "../src/auth/AuthProvider";
import { RunsPage } from "../src/pages/RunsPage";

function createSession() {
  const session = new TokenSession();
  session.login("task-12-test-token");
  return session;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function sourceFixture() {
  return { id: "source-a", host: "news.example.test" };
}

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    source_id: "legacy-global-source",
    started_at: 1_800_000_000,
    finished_at: 1_800_000_060,
    status: "partial",
    http_status: 200,
    discovered_count: 8,
    stored_count: 6,
    error_code: "some_items_failed",
    error_message: "Some items could not be processed",
    duration_seconds: 60,
    ...overrides,
  };
}

function overviewFixture() {
  return {
    storage: { state: "normal", observed_db_size: 0, warning_threshold_bytes: 280 * 1_048_576, hard_stop_threshold_bytes: 300 * 1_048_576 },
    pending: { active_count: 0, disabled_count: 0, oldest_age_seconds: null, by_status: { active: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 }, disabled: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 } } },
    sources: { enabled_count: 0, disabled_count: 0, overdue_count: 0 },
    runs_24h: { running: 0, succeeded: 0, partial: 0, failed: 0, blocked: 0, storage_limit: 0 },
    latest_run: null,
  };
}

describe("Runs page", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("serializes status and source filters and pages with opaque cursors in both directions", async () => {
    const runRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [sourceFixture(), { id: "source-b", host: "daily.example.test" }] });
      if (url.pathname === "/v1/runs") {
        runRequests.push(url);
        if (url.searchParams.get("cursor") === "opaque+/next==") {
          return jsonResponse({ runs: [runFixture({ id: "run-2", status: "failed" })], next_cursor: null });
        }
        return jsonResponse({ runs: [runFixture()], next_cursor: "opaque+/next==" });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<RunsPage session={createSession()} />);
    expect(await screen.findByRole("heading", { name: "Run run-1" })).toBeTruthy();
    expect(runRequests[0]?.searchParams.get("limit")).toBe("20");

    fireEvent.change(screen.getByLabelText(/run status/i), { target: { value: "partial" } });
    fireEvent.change(screen.getByLabelText(/run source/i), { target: { value: "source-b" } });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));
    await waitFor(() => expect(runRequests.length).toBe(2));
    expect(runRequests[1]?.searchParams.get("status")).toBe("partial");
    expect(runRequests[1]?.searchParams.get("source_id")).toBe("source-b");
    expect(runRequests[1]?.searchParams.get("limit")).toBe("20");
    expect(runRequests[1]?.searchParams.has("cursor")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByRole("heading", { name: "Run run-2" })).toBeTruthy();
    expect(runRequests[2]?.searchParams.get("cursor")).toBe("opaque+/next==");
    expect(runRequests[2]?.searchParams.get("source_id")).toBe("source-b");

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));
    expect(await screen.findByRole("heading", { name: "Run run-1" })).toBeTruthy();
    expect(runRequests[3]?.searchParams.has("cursor")).toBe(false);
  });

  it("loads per-source details without trusting the run-global source ID and renders errors as text", async () => {
    const detailMessage = '<img src=x onerror="alert(1)"> https://safe.example.test/path';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      if (url.pathname === "/v1/runs/run-1") return jsonResponse({
        run: runFixture({ error_message: detailMessage }),
        sources: [
          { source_id_snapshot: "source-a", status: "succeeded", http_status: 200, discovered_count: 5, stored_count: 4, error_code: null, error_message: null },
          { source_id_snapshot: "source-b", status: "blocked", http_status: 403, discovered_count: 3, stored_count: 2, error_code: "source_blocked", error_message: detailMessage },
        ],
      });
      if (url.pathname === "/v1/runs") return jsonResponse({ runs: [runFixture()], next_cursor: null });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RunsPage session={createSession()} />);
    expect(await screen.findByRole("heading", { name: "Run run-1" })).toBeTruthy();
    expect(screen.getByText("60 seconds")).toBeTruthy();
    expect(screen.getByText("HTTP 200")).toBeTruthy();
    expect(screen.getByText("8 discovered · 6 stored")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /show source details/i }));
    expect(await screen.findByText(/Source ID: source-a/)).toBeTruthy();
    expect(screen.getByText(/Source ID: source-b/)).toBeTruthy();
    expect(screen.getByText("HTTP 403")).toBeTruthy();
    expect(screen.getByText("3 discovered · 2 stored")).toBeTruthy();
    expect(screen.getByText(detailMessage)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/v1/runs/run-1"))).toBe(true);
    expect(screen.queryByText("legacy-global-source")).toBeNull();
  });

  it("retries a failed source-detail request without closing the expanded panel", async () => {
    let detailRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      if (url.pathname === "/v1/runs") return jsonResponse({ runs: [runFixture()], next_cursor: null });
      if (url.pathname === "/v1/runs/run-1") {
        detailRequests += 1;
        if (detailRequests === 1) return jsonResponse({ error: { code: "internal_error", message: "Details temporarily unavailable", request_id: "req-detail" } }, 500);
        return jsonResponse({ run: runFixture(), sources: [] });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<RunsPage session={createSession()} />);
    expect(await screen.findByRole("heading", { name: "Run run-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show source details/i }));
    expect(await screen.findByText("Details temporarily unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry source details/i }));
    expect(await screen.findByText(/no per-source records were stored/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide source details/i }).getAttribute("aria-expanded")).toBe("true");
    expect(detailRequests).toBe(2);
  });

  it("shows loading, empty, and retryable API error states", async () => {
    let resolveRuns: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname === "/v1/runs") {
        if (fetchMock.mock.calls.filter(([call]) => new URL(String(call), window.location.origin).pathname === "/v1/runs").length === 1) {
          return new Promise<Response>((resolve) => { resolveRuns = resolve; });
        }
        return Promise.resolve(jsonResponse({ runs: [], next_cursor: null }));
      }
      return Promise.resolve(jsonResponse({ error: { code: "internal_error", message: "Run history unavailable", request_id: "req-12" } }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RunsPage session={createSession()} />);
    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    resolveRuns?.(jsonResponse({ error: { code: "internal_error", message: "Run history unavailable", request_id: "req-12" } }, 500));
    expect(await screen.findByText("Run history unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/no fetch runs match these filters/i)).toBeTruthy();
  });

  it("opens Runs and Errors through mobile-friendly primary navigation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/overview") return jsonResponse(overviewFixture());
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      if (url.pathname === "/v1/runs") return jsonResponse({ runs: [], next_cursor: null });
      if (url.pathname === "/v1/errors") return jsonResponse({ errors: [], next_cursor: null });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: "task-12-app-token" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("link", { name: /^runs$/i }));
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: /main navigation/i }).querySelectorAll("a").length).toBeGreaterThanOrEqual(5);
    fireEvent.click(screen.getByRole("link", { name: /^errors$/i }));
    expect(await screen.findByRole("heading", { name: "Errors" })).toBeTruthy();
    expect(window.location.pathname).toBe("/errors");
  });
});
