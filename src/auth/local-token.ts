import type { Env } from "../env";

function unauthorized(): Response {
  return Response.json(
    {
      error: {
        code: "unauthorized",
        message: "Authentication required",
        request_id: crypto.randomUUID(),
      },
    },
    { status: 401 },
  );
}

function authenticatedToken(request: Request, env: Env): string | null {
  if (env.APP_ENV === "production" && typeof env.API_TOKEN !== "string") return null;
  if (typeof env.API_TOKEN !== "string" || env.API_TOKEN.trim() === "") return null;
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token !== undefined && token === env.API_TOKEN ? token : null;
}

async function rateLimitKeyForToken(env: Env, token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${env.APP_ENV}:${hex}`;
}

export async function rateLimitKey(request: Request, env: Env): Promise<string | null> {
  const token = authenticatedToken(request, env);
  return token === null ? null : await rateLimitKeyForToken(env, token);
}

export async function authenticateWithRateLimitKey(
  request: Request,
  env: Env,
): Promise<Response | string> {
  const key = await rateLimitKey(request, env);
  return key === null ? unauthorized() : key;
}

export async function authenticateLocal(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const result = await authenticateWithRateLimitKey(request, env);
  return typeof result === "string" ? null : result;
}
