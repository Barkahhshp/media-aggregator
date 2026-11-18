import type { TokenSession } from "../auth/AuthProvider";

export async function apiRequest(
  session: Pick<TokenSession, "getToken" | "clear">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = session.getToken();
  if (token === null) throw new Error("Sign in is required to call the private API");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Dashboard API requests must be same-origin");
  }

  const requestUrl = new URL(path, window.location.origin);
  if (requestUrl.origin !== window.location.origin) {
    throw new Error("Dashboard API requests must be same-origin");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });

  if (response.status === 401) session.clear();
  return response;
}
