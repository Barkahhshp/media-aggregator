import { Hono } from "hono";
import type { Env } from "../env";
import { createSource, disableSource, getSource, listSources, SourceRepositoryError, updateSource } from "../sources/repository";
import type { ApiError, SourcePatchInput } from "../sources/types";
import { isApiError, MAX_SOURCE_REQUEST_BYTES, validateSourceInput } from "../sources/validation";

export const sources = new Hono<{ Bindings: Env }>();

function apiErrorResponse(error: ApiError, request: Request): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
      },
    },
    { status: error.status },
  );
}

function repositoryErrorResponse(error: SourceRepositoryError, request: Request): Response {
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message }, request);
}

async function readJsonBody(request: Request): Promise<{ value: unknown } | { error: ApiError }> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_SOURCE_REQUEST_BYTES) {
      return { error: { status: 413, code: "request_too_large", message: "Request body exceeds 32 KiB" } };
    }
  }
  if (request.body === null) {
    return { error: { status: 400, code: "invalid_json", message: "A JSON request body is required" } };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SOURCE_REQUEST_BYTES) {
        await reader.cancel();
        return { error: { status: 413, code: "request_too_large", message: "Request body exceeds 32 KiB" } };
      }
      chunks.push(value);
    }
  } catch {
    return { error: { status: 400, code: "invalid_json", message: "Request body could not be read" } };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { error: { status: 400, code: "invalid_json", message: "Request body must be valid UTF-8 JSON" } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePatchShape(value: unknown): SourcePatchInput | ApiError {
  if (!isRecord(value)) {
    return { status: 400, code: "invalid_source_update", message: "Source update must be a JSON object" };
  }
  const allowed = new Set(["poll_interval_sec", "selectors", "enabled"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || Object.keys(value).length === 0) {
    return { status: 400, code: "invalid_source_update", message: "Source update contains unsupported or no fields" };
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { status: 400, code: "invalid_source_update", message: "enabled must be a boolean" };
  }
  return value as SourcePatchInput;
}

sources.get("/v1/sources", async (context) => {
  const result = await listSources(context.env.DB);
  return context.json({ sources: result });
});

sources.post("/v1/sources", async (context) => {
  const parsed = await readJsonBody(context.req.raw);
  if ("error" in parsed) return apiErrorResponse(parsed.error, context.req.raw);

  const input = validateSourceInput(parsed.value);
  if (isApiError(input)) return apiErrorResponse(input, context.req.raw);

  try {
    const source = await createSource(context.env.DB, input);
    return context.json({ source }, 201);
  } catch (error) {
    if (error instanceof SourceRepositoryError) return repositoryErrorResponse(error, context.req.raw);
    throw error;
  }
});

sources.patch("/v1/sources/:id", async (context) => {
  const parsed = await readJsonBody(context.req.raw);
  if ("error" in parsed) return apiErrorResponse(parsed.error, context.req.raw);
  const patch = validatePatchShape(parsed.value);
  if (isApiError(patch)) return apiErrorResponse(patch, context.req.raw);

  const current = await getSource(context.env.DB, context.req.param("id"));
  if (current === null) {
    return apiErrorResponse({ status: 404, code: "source_not_found", message: "Source not found" }, context.req.raw);
  }
  const update = patch as SourcePatchInput;
  const candidate = validateSourceInput({
    kind: current.kind,
    url: current.url,
    poll_interval_sec: update.poll_interval_sec ?? current.poll_interval_sec,
    selectors: update.selectors === undefined ? current.selectors ?? undefined : update.selectors,
  });
  if (isApiError(candidate)) return apiErrorResponse(candidate, context.req.raw);

  try {
    const source = await updateSource(context.env.DB, current.id, candidate, update.enabled);
    if (source === null) {
      return apiErrorResponse({ status: 404, code: "source_not_found", message: "Source not found" }, context.req.raw);
    }
    return context.json({ source });
  } catch (error) {
    if (error instanceof SourceRepositoryError) return repositoryErrorResponse(error, context.req.raw);
    throw error;
  }
});

sources.delete("/v1/sources/:id", async (context) => {
  const source = await disableSource(context.env.DB, context.req.param("id"));
  if (source === null) {
    return apiErrorResponse({ status: 404, code: "source_not_found", message: "Source not found" }, context.req.raw);
  }
  return context.json({ source });
});
