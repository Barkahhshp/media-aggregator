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
