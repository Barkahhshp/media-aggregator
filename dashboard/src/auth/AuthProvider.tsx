import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export class TokenSession {
  private tokenValue: string | null = null;
  private readonly listeners = new Set<() => void>();

  getToken = (): string | null => this.tokenValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  login(token: string): void {
    if (token.trim() === "" || token === this.tokenValue) return;
    this.tokenValue = token;
    this.notify();
  }

  clear(): void {
    if (this.tokenValue === null) return;
    this.tokenValue = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

interface AuthContextValue {
  token: string | null;
  session: TokenSession;
  login(token: string): void;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "pointerdown",
  "keydown",
  "mousemove",
  "touchstart",
  "scroll",
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const sessionRef = useRef<TokenSession | null>(null);
  if (sessionRef.current === null) sessionRef.current = new TokenSession();
  const session = sessionRef.current;
  const token = useSyncExternalStore(session.subscribe, session.getToken, session.getToken);

  const login = useCallback((value: string) => session.login(value), [session]);
  const logout = useCallback(() => session.clear(), [session]);

  useEffect(() => {
    if (token === null) return undefined;

    let timeoutId: number | undefined;
    const refreshIdleTimeout = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => session.clear(), SESSION_IDLE_TIMEOUT_MS);
    };

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, refreshIdleTimeout, { passive: true });
    }
    refreshIdleTimeout();

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, refreshIdleTimeout);
      }
    };
  }, [session, token]);

  const value = useMemo(() => ({ token, session, login, logout }), [token, session, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
