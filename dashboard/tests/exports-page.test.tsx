import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ExportsPage } from "../src/pages/ExportsPage";
import { AuthProvider, TokenSession } from "../src/auth/AuthProvider";

const API_TOKEN = "task-13-private-api-token";
const SNAPSHOT = {
  id: "export-session-13",
  snapshot_id: "snapshot-13",
  counts: { sources: 1, pending_items: 0, articles: 0 },
  expires_at: 2_000_000_000,
  cursor: null as string | null,
};

function createSession() {
  const session = new TokenSession();
  session.login(API_TOKEN);
  return session;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function ndjsonPage(nextCursor: string | null, snapshotId = SNAPSHOT.snapshot_id, id = "source-13", counts = SNAPSHOT.counts) {
  const manifest = {
    type: "manifest",
    schema_version: 1,
    snapshot_id: snapshotId,
    export_watermark: "1800000000",
    exported_at: 1_800_000_000,
    counts,
    full_text_encoding: "base64-utf8",
    next_cursor: nextCursor,
  };
  const record = { type: "source", record: { id, url: "https://feed.example.test/rss" } };
  return `${JSON.stringify(manifest)}\n${JSON.stringify(record)}\n`;
}

function urlFrom(input: RequestInfo | URL): URL {
  return new URL(String(input), window.location.origin);
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Exports and backups page", () => {
  it("shows the lock warning and requires a clear action before starting an export", async () => {
    const requests: Array<{ url: URL; method: string; authorization: string | null }> = [];
    let started = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlFrom(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, authorization: new Headers(init?.headers).get("Authorization") });
      if (url.pathname === "/v1/exports/active") return jsonResponse({ session: started ? SNAPSHOT : null });
      if (url.pathname === "/v1/exports" && method === "POST") {
        started = true;
        return jsonResponse({ session: { id: SNAPSHOT.id, snapshot_id: SNAPSHOT.snapshot_id, export_watermark: "1800000000", expires_at: SNAPSHOT.expires_at, state: "active" } }, 201);
      }
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "GET") return new Response(ndjsonPage(null), { headers: { "Content-Type": "application/x-ndjson" } });
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "DELETE") return jsonResponse({ status: "ended", session_id: SNAPSHOT.id });
      return jsonResponse({ error: { message: "Unexpected request" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:task-13-started") });

    render(<ExportsPage session={createSession()} />);

    expect(await screen.findByText(/export lock pauses the scheduler and blocks source changes/i)).toBeTruthy();
    expect(requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual(["GET /v1/exports/active"]);
    const startButton = screen.getByRole("button", { name: /i understand.*start backup/i });
    fireEvent.click(startButton);

    expect(await screen.findByRole("heading", { name: /backup is ready/i })).toBeTruthy();
    await waitFor(() => expect(requests.some(({ method, url }) => method === "DELETE" && url.pathname.endsWith(SNAPSHOT.id))).toBe(true));
    expect(requests.some(({ method, url }) => method === "POST" && url.pathname === "/v1/exports")).toBe(true);
    expect(screen.getByText(/1 source, 0 pending items, 0 articles/i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Export lock released");
    expect(requests.every(({ authorization }) => authorization === `Bearer ${API_TOKEN}`)).toBe(true);
  });

  it("recovers the active snapshot from page one and reports page and record progress", async () => {
    const counts = { sources: 2, pending_items: 0, articles: 0 };
    const recoverySnapshot = { ...SNAPSHOT, counts };
    const requestedPages: URL[] = [];
    const requests: Array<{ url: URL; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlFrom(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.pathname === "/v1/exports/active") return jsonResponse({ session: { ...recoverySnapshot, cursor: "server-cursor-must-not-resume-partial-file" } });
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "GET") {
        requestedPages.push(url);
        if (url.searchParams.get("cursor") === "page-2") return new Response(ndjsonPage(null, SNAPSHOT.snapshot_id, "source-14", counts), { headers: { "Content-Type": "application/x-ndjson" } });
        return new Response(ndjsonPage("page-2", SNAPSHOT.snapshot_id, "source-13", counts), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "DELETE") return jsonResponse({ status: "ended", session_id: SNAPSHOT.id });
      return jsonResponse({ error: { message: "Unexpected request" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:task-13-backup");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });

    render(<ExportsPage session={createSession()} />);

    expect(await screen.findByRole("heading", { name: /active backup snapshot/i })).toBeTruthy();
    expect(screen.getByText(/2 sources, 0 pending items, 0 articles/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /download complete backup/i }));

    expect(await screen.findByRole("heading", { name: /backup is ready/i })).toBeTruthy();
    expect(requestedPages).toHaveLength(2);
    expect(requestedPages[0]?.search).toBe("");
    expect(requestedPages[1]?.searchParams.get("cursor")).toBe("page-2");
    expect(requests.some(({ method }) => method === "POST")).toBe(false);
    expect(screen.getByText(/2 pages/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /download backup file/i }).getAttribute("download")).toMatch(/^media-aggregator-backup-.*\.ndjson$/u);
    expect(screen.getByRole("status").textContent).toContain("Export lock released");
  });

  it("does not invent zero counts when the just-started session cannot be read back", async () => {
    let activeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlFrom(input);
      const method = init?.method ?? "GET";
      if (url.pathname === "/v1/exports/active") {
        activeCalls += 1;
        return activeCalls === 1 ? jsonResponse({ session: null }) : jsonResponse({ error: { code: "internal_error" } }, 500);
      }
      if (url.pathname === "/v1/exports" && method === "POST") {
        return jsonResponse({ session: { id: SNAPSHOT.id, snapshot_id: SNAPSHOT.snapshot_id, expires_at: SNAPSHOT.expires_at } }, 201);
      }
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "DELETE") return jsonResponse({ error: { code: "internal_error" } }, 500);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ExportsPage session={createSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: /i understand.*start backup/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/0 sources, 0 pending items, 0 articles/i)).toBeNull();
    expect(screen.getByText(/record counts unavailable/i)).toBeTruthy();
    expect(screen.getByText(/cleanup could not be confirmed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry status check/i })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("keeps an incomplete backup unavailable and warns when the expired session cannot be cleaned up", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlFrom(input);
      const method = init?.method ?? "GET";
      if (url.pathname === "/v1/exports/active") return jsonResponse({ session: SNAPSHOT });
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "GET") {
        return jsonResponse({ error: { code: "export_expired", message: "expired" } }, 410);
      }
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "DELETE") return jsonResponse({ error: { code: "export_expired" } }, 410);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:should-not-exist");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });

    render(<ExportsPage session={createSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: /download complete backup/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/export expired|incomplete/i)).toBeTruthy();
    expect(screen.getByText(/cleanup could not be confirmed/i)).toBeTruthy();
    expect(screen.getByText(/lock may remain until/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /download backup file/i })).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("does not expose the API token in the download filename, downloaded page content, or logs", async () => {
    const requests: Array<{ url: URL; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlFrom(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.pathname === "/v1/exports/active") return jsonResponse({ session: SNAPSHOT });
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "GET") return new Response(ndjsonPage(null), { headers: { "Content-Type": "application/x-ndjson" } });
      if (url.pathname === `/v1/exports/${SNAPSHOT.id}` && method === "DELETE") return jsonResponse({ status: "ended" });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const captured = { blob: null as Blob | null };
    const createObjectURL = vi.fn((blob: Blob) => {
      captured.blob = blob;
      return "blob:token-safe-backup";
    });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    const consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];

    render(<ExportsPage session={createSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: /download complete backup/i }));
    const link = await screen.findByRole("link", { name: /download backup file/i });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const blob = captured.blob;
    expect(blob).toBeInstanceOf(Blob);
    if (blob === null) throw new Error("The backup Blob was not created");
    expect(await blob.text()).not.toContain(API_TOKEN);
    expect(link.getAttribute("download")).not.toContain(API_TOKEN);
    expect(requests.every(({ url }) => !url.href.includes(API_TOKEN))).toBe(true);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()).some((value) => String(value).includes(API_TOKEN))).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("opens the Exports and Backups screen from the application navigation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlFrom(input);
      if (url.pathname === "/v1/overview") return jsonResponse({
        storage: { state: "normal", observed_db_size: 0, warning_threshold_bytes: 1, hard_stop_threshold_bytes: 2 },
        pending: { active_count: 0, disabled_count: 0, oldest_age_seconds: null, by_status: { active: {}, disabled: {} } },
        sources: { enabled_count: 0, disabled_count: 0, overdue_count: 0 },
        runs_24h: { running: 0, succeeded: 0, partial: 0, failed: 0, blocked: 0, storage_limit: 0 },
        latest_run: null,
      });
      if (url.pathname === "/v1/exports/active") return jsonResponse({ session: null });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: API_TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("link", { name: /exports and backups/i }));

    expect(await screen.findByRole("heading", { name: /exports and backups/i })).toBeTruthy();
    expect(window.location.pathname).toBe("/exports");
  });
});
