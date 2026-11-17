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

async function accessServiceTokenIdentity(access: CloudflareAccessContext | undefined, env: Env): Promise<string | null> {
  if (!access || typeof env.ACCESS_AUD !== "string" || env.ACCESS_AUD.trim() === "" || access.aud !== env.ACCESS_AUD) {
    return null;
  }
  try {
    const identity = await access.getIdentity();
    const serviceTokenId = identity?.service_token_id;
    return identity?.service_token_status === true && typeof serviceTokenId === "string" && serviceTokenId.trim() !== ""
      ? serviceTokenId
      : null;
  } catch {
    return null;
  }
}

async function identityForRequest(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<string | null> {
  if (env.APP_ENV === "production") return await accessServiceTokenIdentity(access, env);
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token !== undefined && token === env.API_TOKEN ? token : null;
}

async function rateLimitKeyForIdentity(env: Env, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${env.APP_ENV}:${hex}`;
}

export async function rateLimitKey(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<string | null> {
  const identity = await identityForRequest(request, env, access);
  if (identity === null) return null;
  return await rateLimitKeyForIdentity(env, identity);
}

export async function authenticateWithRateLimitKey(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<Response | string> {
  const identity = await identityForRequest(request, env, access);
  if (identity === null) return unauthorized();
  return await rateLimitKeyForIdentity(env, identity);
}

export async function authenticateLocal(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<Response | null> {
  const result = await authenticateWithRateLimitKey(request, env, access);
  return typeof result === "string" ? null : result;
}
