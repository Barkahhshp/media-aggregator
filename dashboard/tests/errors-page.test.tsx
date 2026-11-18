import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenSession } from "../src/auth/AuthProvider";
import { ErrorsPage } from "../src/pages/ErrorsPage";

function createSession() {
  const session = new TokenSession();
  session.login("task-12-errors-token");
  return session;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function groupFixture(overrides: Record<string, unknown> = {}) {
  return {
    origin: "pending",
    source_id: "source-a",
    code: "fetch_error",
    status: "retry_wait",
    count: 3,
    first_time: 1_800_000_000,
    last_time: 1_800_000_060,
    samples: [{ time: 1_800_000_060, message: "Retry https://secret.example.test/path token=hidden" }],
    ...overrides,
  };
}

function sourceFixture() {
  return { id: "source-a", host: "news.example.test" };
}

describe("Errors page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("labels run and pending error origins separately and renders sanitized messages as text", async () => {
    const maliciousMessage = '<img src=x onerror="alert(1)"> https://safe.example.test/path';
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [sourceFixture()] });
      if (url.pathname === "/v1/errors") return jsonResponse({ errors: [
        groupFixture({ origin: "run", source_id: "source-a", code: "source_blocked", status: "blocked", count: 2, samples: [{ time: 1_800_000_070, message: maliciousMessage }] }),
        groupFixture({ origin: "pending", source_id: "source-a", code: "fetch_error", status: "retry_wait", samples: [{ time: 1_800_000_060, message: "Waiting to retry" }] }),
        groupFixture({ origin: "pending", source_id: "source-a", code: "storage_full", status: "failed", samples: [{ time: 1_800_000_080, message: "Storage limit reached" }] }),
        groupFixture({ origin: "run", source_id: "source-a", code: "storage_limit", status: "storage_limit", count: 1, samples: [] }),
      ], next_cursor: null });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<ErrorsPage session={createSession()} />);
    expect(await screen.findByText("source_blocked")).toBeTruthy();
    expect(screen.getAllByText("Run error group").length).toBe(2);
    expect(screen.getAllByText("Pending-item error group").length).toBe(2);
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("Storage limit")).toBeTruthy();
    expect(screen.getAllByText("Waiting to retry").length).toBe(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(maliciousMessage)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("button", { name: /show matching pending items/i })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /retry item|purge|edit pending/i })).toBeNull();
  });

  it("drills into pending items with whitelisted status and source filters only", async () => {
    const requests: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      requests.push(url);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [sourceFixture()] });
      if (url.pathname === "/v1/errors") return jsonResponse({ errors: [groupFixture()], next_cursor: null });
      if (url.pathname === "/v1/pending") return jsonResponse({ pending: [
        { id: "pending-1", source_id: "source-a", item_type: "article", title: '<svg onload="alert(1)">Story title', status: "retry_wait", attempts: 2, next_attempt_at: 1_800_000_200, terminal_expires_at: null, error_code: "fetch_error", error_message: "Request failed" },
      ], next_cursor: null });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ErrorsPage session={createSession()} />);
    await screen.findByText("fetch_error");
    fireEvent.click(screen.getByRole("button", { name: /show matching pending items/i }));

    expect(await screen.findByText(/ID: pending-1/)).toBeTruthy();
    const pendingRequest = requests.find((url) => url.pathname === "/v1/pending");
    expect(pendingRequest?.searchParams.get("status")).toBe("retry_wait");
    expect(pendingRequest?.searchParams.get("source_id")).toBe("source-a");
    expect(pendingRequest?.searchParams.get("limit")).toBe("20");
    expect(screen.getByText('<svg onload="alert(1)">Story title')).toBeTruthy();
    expect(document.querySelector("svg")).toBeNull();
    expect(screen.getAllByText("Waiting to retry").length).toBe(2);
    expect(screen.queryByText("lease-token-value")).toBeNull();
  });

  it("does not offer pending drill-down for live-lease statuses excluded from the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [] });
      if (url.pathname === "/v1/errors") return jsonResponse({ errors: [groupFixture({ code: "lease_error", status: "leased" })], next_cursor: null });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<ErrorsPage session={createSession()} />);
    expect(await screen.findByText("lease_error")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show matching pending items/i })).toBeNull();
    expect(screen.getByText(/status is not available in the safe pending-item list/i)).toBeTruthy();
  });

  it("serializes source filters and preserves opaque cursor paging", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return jsonResponse({ sources: [sourceFixture(), { id: "source-b", host: "daily.example.test" }] });
      if (url.pathname === "/v1/errors") {
        requests.push(url);
        return url.searchParams.get("cursor") === "opaque/error+cursor=="
          ? jsonResponse({ errors: [groupFixture({ source_id: "source-b", code: "parse_error" })], next_cursor: null })
          : jsonResponse({ errors: [groupFixture()], next_cursor: "opaque/error+cursor==" });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<ErrorsPage session={createSession()} />);
    expect(await screen.findByText("fetch_error")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/error source/i), { target: { value: "source-b" } });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));
    await waitFor(() => expect(requests.length).toBe(2));
    expect(requests[1]?.searchParams.get("source_id")).toBe("source-b");
    expect(requests[1]?.searchParams.get("limit")).toBe("20");
    expect(requests[1]?.searchParams.has("cursor")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText("parse_error")).toBeTruthy();
    expect(requests[2]?.searchParams.get("cursor")).toBe("opaque/error+cursor==");
    expect(requests[2]?.searchParams.get("source_id")).toBe("source-b");
  });

  it("shows loading, empty, and retryable API error states", async () => {
    let resolveErrors: ((response: Response) => void) | undefined;
    let errorCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/v1/sources") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname === "/v1/errors") {
        errorCalls += 1;
        if (errorCalls === 1) return new Promise<Response>((resolve) => { resolveErrors = resolve; });
        if (errorCalls === 2) return Promise.resolve(jsonResponse({ errors: [], next_cursor: null }));
        return Promise.resolve(jsonResponse({ errors: [], next_cursor: null }));
      }
      return Promise.resolve(jsonResponse({ errors: [], next_cursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ErrorsPage session={createSession()} />);
    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    resolveErrors?.(jsonResponse({ error: { code: "internal_error", message: "Error history unavailable", request_id: "req-12" } }, 500));
    expect(await screen.findByText("Error history unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/no error groups to show/i)).toBeTruthy();
  });
});
