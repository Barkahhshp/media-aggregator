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

function accessServiceTokenIdentity(request: Request): string | null {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const payloadPart = assertion?.split(".")[1];
  if (payloadPart === undefined) return null;
  try {
    const normalized = payloadPart.replace(/-/gu, "+").replace(/_/gu, "/");
    const payload = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4))) as { common_name?: unknown };
    return typeof payload.common_name === "string" && payload.common_name.trim() !== ""
      ? payload.common_name
      : null;
  } catch {
    return null;
  }
}

export async function rateLimitKey(request: Request, env: Env): Promise<string | null> {
  let identity: string | null;
  if (env.APP_ENV === "production") {
    identity = accessServiceTokenIdentity(request);
  } else {
    const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
    identity = match?.[1] ?? null;
  }
  if (identity === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${env.APP_ENV}:${hex}`;
}

export function authenticateLocal(request: Request, env: Env): Response | null {
  if (env.APP_ENV === "production") {
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    return assertion && assertion.trim().length > 0 ? null : unauthorized();
  }

  if (!env.API_TOKEN) return unauthorized();
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] === env.API_TOKEN ? null : unauthorized();
}
