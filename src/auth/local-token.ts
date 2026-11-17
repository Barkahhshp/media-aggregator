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
  return match?.[1] ?? null;
}

export async function rateLimitKey(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<string | null> {
  const identity = await identityForRequest(request, env, access);
  if (identity === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${env.APP_ENV}:${hex}`;
}

export async function authenticateLocal(
  request: Request,
  env: Env,
  access?: CloudflareAccessContext,
): Promise<Response | null> {
  if (env.APP_ENV === "production") {
    return (await accessServiceTokenIdentity(access, env)) === null ? unauthorized() : null;
  }

  if (!env.API_TOKEN) return unauthorized();
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] === env.API_TOKEN ? null : unauthorized();
}
