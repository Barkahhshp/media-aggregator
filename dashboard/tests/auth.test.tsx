import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "../src/App";
import { AuthProvider } from "../src/auth/AuthProvider";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

function logIn(token = "task-9-test-token") {
  fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("in-memory authentication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts a token without putting it in the URL", () => {
    renderApp();
    logIn();

    expect(screen.getByText(/signed in/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /log out/i })).toBeTruthy();
    expect(window.location.href).not.toContain("task-9-test-token");
  });

  it("clears the session after 15 minutes without activity", () => {
    renderApp();
    logIn();

    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1));
    expect(screen.getByText(/signed in/i)).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText(/api token/i)).toBeTruthy();
    expect(screen.queryByText(/signed in/i)).toBeNull();
  });

  it("refreshes the idle deadline when the user is active", () => {
    renderApp();
    logIn();

    act(() => vi.advanceTimersByTime(14 * 60 * 1000));
    fireEvent.keyDown(window, { key: "a" });
    act(() => vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000));
    expect(screen.getByText(/signed in/i)).toBeTruthy();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText(/api token/i)).toBeTruthy();
  });

  it("clears the session on logout", () => {
    renderApp();
    logIn();

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    expect(screen.getByLabelText(/api token/i)).toBeTruthy();
    expect(screen.queryByText(/signed in/i)).toBeNull();
  });

  it("asks for a token again after a reload-like remount", () => {
    const mounted = renderApp();
    logIn();
    mounted.unmount();

    renderApp();

    expect(screen.getByLabelText(/api token/i)).toBeTruthy();
    expect(screen.queryByText(/signed in/i)).toBeNull();
  });

  it("does not use browser persistence APIs for token storage", () => {
    const sources = [
      readFileSync(resolve(process.cwd(), "dashboard/src/auth/AuthProvider.tsx"), "utf8"),
      readFileSync(resolve(process.cwd(), "dashboard/src/api/client.ts"), "utf8"),
    ].join("\n");

    expect(sources).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/i);
  });
});
