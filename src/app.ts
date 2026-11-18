import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { authenticateWithRateLimitKey } from "./auth/local-token";
import { health } from "./routes/health";
import { sources } from "./routes/sources";
import { articles } from "./routes/articles";
import { exports } from "./routes/exports";
import { status } from "./routes/status";
import { runs } from "./routes/runs";
import { errors } from "./routes/errors";
import { pending } from "./routes/pending";
import { overview } from "./routes/overview";
import { auditActions } from "./routes/audit-actions";

const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ["Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
];

function isApiPath(path: string): boolean {
  return /^\/v1(?:\/|$)/.test(path);
}

function isHealthPath(path: string): boolean {
  return /^\/health(?:\/|$)/.test(path);
}

function applySecurityHeaders(headers: Headers, noStore: boolean): void {
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  if (noStore) headers.set("Cache-Control", "no-store");
}

function withSecurityHeaders(response: Response, noStore = false): Response {
  try {
    applySecurityHeaders(response.headers, noStore);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    applySecurityHeaders(headers, noStore);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function apiNotFound(requestId: string): Response {
  return Response.json(
    { error: { code: "not_found", message: "Not found", request_id: requestId } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

const apiResponseHeaders: MiddlewareHandler<{ Bindings: Env }> = async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
  return withSecurityHeaders(context.res, true);
};

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (context, next) => {
    const apiRequest = isApiPath(context.req.path);
    for (const [name, value] of SECURITY_HEADERS) context.header(name, value);
    if (apiRequest) context.header("Cache-Control", "no-store");
    if (apiRequest) {
      const authenticated = await authenticateWithRateLimitKey(context.req.raw, context.env);
      if (typeof authenticated !== "string") return withSecurityHeaders(authenticated, true);
      try {
        const { success } = await context.env.RATE_LIMITER.limit({ key: authenticated });
        if (!success) {
          return withSecurityHeaders(context.json({
            error: {
              code: "rate_limit_exceeded",
              message: "Request rate limit exceeded",
              request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
            },
          }, 429), true);
        }
      } catch {
        return withSecurityHeaders(context.json({
          error: {
            code: "rate_limiter_unavailable",
            message: "Request could not be processed",
            request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
          },
        }, 503), true);
      }
    }

    await next();
    const isHtml = context.res.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
    return withSecurityHeaders(context.res, apiRequest || isHtml);
  });

  app.use("/health", async (context, next) => {
    if (context.env.APP_ENV !== "production") return await next();
    const authenticated = await authenticateWithRateLimitKey(context.req.raw, context.env);
    if (typeof authenticated !== "string") return authenticated;
    await next();
  });

  app.use("/v1", apiResponseHeaders);
  app.use("/v1/*", apiResponseHeaders);

  app.route("/", health);
  app.route("/", sources);
  app.route("/", articles);
  app.route("/", exports);
  app.route("/", status);
  app.route("/", runs);
  app.route("/", errors);
  app.route("/", pending);
  app.route("/", overview);
  app.route("/", auditActions);

  app.notFound(async (context) => {
    if (isApiPath(context.req.path)) {
      return withSecurityHeaders(apiNotFound(context.req.header("X-Request-Id") ?? crypto.randomUUID()), true);
    }
    if (isHealthPath(context.req.path)) return withSecurityHeaders(context.text("Not Found", 404));
    if (context.env.ASSETS !== undefined) {
      const response = await context.env.ASSETS.fetch(context.req.raw);
      const isHtml = response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
      return withSecurityHeaders(response, isHtml);
    }
    return withSecurityHeaders(context.text("Not Found", 404));
  });

  app.onError((_error, context) => {
    const response = context.json(
      {
        error: {
          code: "internal_error",
          message: "Internal server error",
          request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
        },
      },
      500,
    );
    return withSecurityHeaders(response, isApiPath(context.req.path));
  });

  return app;
}
