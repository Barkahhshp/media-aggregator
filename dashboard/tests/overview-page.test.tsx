import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenSession } from "../src/auth/AuthProvider";
import { OverviewPage } from "../src/pages/OverviewPage";

const MIB = 1024 * 1024;

function createSession() {
  const session = new TokenSession();
  session.login("task-10-test-token");
  return session;
}

function overviewFixture(overrides: Record<string, unknown> = {}) {
  return {
    storage: {
      state: "normal",
      observed_db_size: 280 * MIB,
      warning_threshold_bytes: 280 * MIB,
      hard_stop_threshold_bytes: 300 * MIB,
    },
    pending: {
      active_count: 4,
      disabled_count: 2,
      oldest_age_seconds: 7_200,
      by_status: {
        active: { pending: 2, leased: 0, retry_wait: 1, blocked: 1, failed: 0 },
        disabled: { pending: 2, leased: 0, retry_wait: 0, blocked: 0, failed: 0 },
      },
    },
    sources: { enabled_count: 3, disabled_count: 2, overdue_count: 1 },
    runs_24h: { running: 0, succeeded: 1, partial: 2, failed: 3, blocked: 4, storage_limit: 1 },
    latest_run: {
      id: "run-123",
      started_at: 1_800_000_000,
      finished_at: 1_800_000_060,
      status: "partial",
      http_status: 200,
      discovered_count: 8,
      stored_count: 6,
      error_code: "some_items_failed",
      error_message: "Some items could not be processed",
      duration_seconds: 60,
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("Overview page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows loading, then storage, backlog, source, latest-run, and 24-hour summaries with filter links", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onNavigate = vi.fn();

    render(<OverviewPage session={createSession()} onNavigate={onNavigate} />);

    expect(screen.getByRole("status").textContent).toMatch(/loading/i);
    resolveFetch?.(jsonResponse(overviewFixture()));

    expect(await screen.findByText(/warning threshold reached/i)).toBeTruthy();
    expect(screen.getByText(/hard stop at 300 MiB/i)).toBeTruthy();
    expect(screen.getByText("4 active backlog items")).toBeTruthy();
    expect(screen.getByText("2 disabled-source backlog items")).toBeTruthy();
    expect(screen.getByText(/oldest active item: 2 hours/i)).toBeTruthy();
    expect(screen.getByText("1 overdue source")).toBeTruthy();
    expect(screen.getByText("run-123")).toBeTruthy();
    expect(screen.getByText("Some items could not be processed")).toBeTruthy();
    expect(screen.getByText("3 failed")).toBeTruthy();
    expect(screen.getByText("4 blocked")).toBeTruthy();
    expect(screen.getByText("2 partial")).toBeTruthy();
    expect(screen.getByRole("link", { name: /view overdue sources/i }).getAttribute("href")).toBe("/sources?filter=overdue");
    expect(screen.getByRole("link", { name: /view backlog sources/i }).getAttribute("href")).toBe("/sources?filter=backlog");
    expect(screen.getByRole("link", { name: /view disabled-backlog sources/i }).getAttribute("href")).toBe("/sources?filter=backlog&enabled=disabled");
    expect(screen.queryByRole("link", { name: /view failed runs/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view blocked pending items/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view latest run/i })).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/overview");
    fireEvent.click(screen.getByRole("link", { name: /view overdue sources/i }));
    expect(onNavigate).toHaveBeenCalledWith("/sources?filter=overdue");
    fireEvent.click(screen.getByRole("link", { name: /view disabled-backlog sources/i }));
    expect(onNavigate).toHaveBeenCalledWith("/sources?filter=backlog&enabled=disabled");
  });

  it("labels an application hard stop and offers clear empty states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(overviewFixture({
      storage: { state: "storage_limit", observed_db_size: 300 * MIB, warning_threshold_bytes: 280 * MIB, hard_stop_threshold_bytes: 300 * MIB },
      pending: { active_count: 0, disabled_count: 0, oldest_age_seconds: null, by_status: { active: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 }, disabled: { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 } } },
      sources: { enabled_count: 0, disabled_count: 0, overdue_count: 0 },
      runs_24h: { running: 0, succeeded: 0, partial: 0, failed: 0, blocked: 0, storage_limit: 0 },
      latest_run: null,
    }))));

    render(<OverviewPage session={createSession()} onNavigate={vi.fn()} />);

    expect(await screen.findByText(/application hard stop reached/i)).toBeTruthy();
    expect(screen.getByText(/no sources configured yet/i)).toBeTruthy();
    expect(screen.getByText(/no pending backlog/i)).toBeTruthy();
    expect(screen.getByText(/no fetch runs recorded yet/i)).toBeTruthy();
  });

  it("shows an API error with a retry action", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "internal_error", message: "Try again later", request_id: "req-1" } }, 500))
      .mockResolvedValueOnce(jsonResponse(overviewFixture()));
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewPage session={createSession()} onNavigate={vi.fn()} />);

    expect(await screen.findByText("Try again later")).toBeTruthy();
    screen.getByRole("button", { name: /retry/i }).click();
    await waitFor(() => expect(screen.getByText("run-123")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the main Overview cards and summaries available at a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(overviewFixture())));

    render(<OverviewPage session={createSession()} onNavigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Database storage")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Run status summary" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /view overdue sources/i })).toBeTruthy();
  });
});
