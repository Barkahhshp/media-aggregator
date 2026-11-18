import { Hono } from "hono";
import type { Env } from "../env";
import { endExport, ExportRepositoryError, getActiveExportSession, getExportPage, getExportSession, startExport } from "../exports/repository";
import type { ExportSession } from "../exports/repository";

export const exports = new Hono<{ Bindings: Env }>();

function errorResponse(status: number, code: string, message: string, request: Request): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        request_id: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
      },
    },
    { status },
  );
}

function repositoryError(error: unknown, request: Request): Response {
  if (error instanceof ExportRepositoryError) {
    return errorResponse(error.status, error.code, error.message, request);
  }
  throw error;
}

function serializeSession(session: ExportSession): Record<string, unknown> {
  return {
    id: session.id,
    snapshot_id: session.snapshot_id,
    export_watermark: session.export_watermark,
    expires_at: session.expires_at,
    state: session.state,
  };
}

exports.post("/v1/exports", async (context) => {
  try {
    const session = await startExport(context.env.DB);
    return context.json({ session: serializeSession(session) }, 201, { "Cache-Control": "no-store" });
  } catch (error) {
    return repositoryError(error, context.req.raw);
  }
});

exports.get("/v1/exports/active", async (context) => {
  const session = await getActiveExportSession(context.env.DB);
  return context.json({
    session: session === null ? null : {
      id: session.id,
      snapshot_id: session.snapshot_id,
      counts: session.counts,
      expires_at: session.expires_at,
      cursor: session.cursor,
    },
  }, 200, { "Cache-Control": "no-store" });
});

exports.get("/v1/exports/:id", async (context) => {
  const session = await getExportSession(context.env.DB, context.req.param("id"));
  if (session === null) {
    return errorResponse(404, "export_not_found", "The export session was not found", context.req.raw);
  }
  try {
    const cursor = context.req.query("cursor") ?? null;
    const page = await getExportPage(context.env.DB, session, cursor);
    return new Response(page.ndjson, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Export-Record-Count": String(page.record_count),
        "X-Export-Page-Bytes": String(page.byte_count),
      },
    });
  } catch (error) {
    return repositoryError(error, context.req.raw);
  }
});

exports.delete("/v1/exports/:id", async (context) => {
  const id = context.req.param("id");
  const session = await getExportSession(context.env.DB, id);
  if (session === null) {
    return errorResponse(404, "export_not_found", "The export session was not found", context.req.raw);
  }
  try {
    const ended = await endExport(context.env.DB, id);
    if (!ended) return errorResponse(410, "export_expired", "The export session is no longer active", context.req.raw);
    return context.json({ status: "ended", session_id: id }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return repositoryError(error, context.req.raw);
  }
});
