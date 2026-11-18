const MAX_SOURCE_ID_BYTES = 128;
const MAX_ERROR_CODE_BYTES = 128;
const MAX_ERROR_MESSAGE_BYTES = 1024;
const MAX_RUN_SOURCE_COUNT = 1_000;

export const MAX_RUN_SOURCE_SUMMARIES_PER_RUN = 3;

export type RunSourceStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "blocked"
  | "storage_limit"
  | "not_modified"
  | "disabled_source";

export interface RunSourceSummary {
  sourceIdSnapshot: string;
  status: RunSourceStatus;
  httpStatus: number | null;
  discoveredCount: number;
  storedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

const STATUS_PRIORITY: Record<RunSourceStatus, number> = {
  disabled_source: 0,
  not_modified: 1,
  succeeded: 2,
  partial: 3,
  blocked: 4,
  failed: 5,
  storage_limit: 6,
};

const VALID_STATUSES = new Set<RunSourceStatus>(Object.keys(STATUS_PRIORITY) as RunSourceStatus[]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (resultBytes + characterBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}

function sanitizeErrorCode(value: string | null): string | null {
  if (value === null) return null;
  const code = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9_.-]{0,127}$/u.test(code) && byteLength(code) <= MAX_ERROR_CODE_BYTES) return code;
  return "unknown_error";
}

function replaceControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    result += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }
  return result;
}

function sanitizeErrorMessage(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = replaceControlCharacters(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length === 0 ? null : truncateUtf8(sanitized, MAX_ERROR_MESSAGE_BYTES);
}

function assertCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RUN_SOURCE_COUNT) {
    throw new RangeError(`${field} must be an integer between 0 and ${MAX_RUN_SOURCE_COUNT}`);
  }
  return value;
}

function httpStatusPriority(value: number | null): number {
  if (value === null) return 0;
  if (value >= 400) return 4;
  if (value >= 200 && value < 300) return 3;
  if (value === 304) return 2;
  return 1;
}

function selectHttpStatus(left: number | null, right: number | null): number | null {
  const leftPriority = httpStatusPriority(left);
  const rightPriority = httpStatusPriority(right);
  if (rightPriority > leftPriority) return right;
  if (leftPriority > rightPriority) return left;
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function errorCandidate(summary: RunSourceSummary): { status: RunSourceStatus; code: string; message: string | null } | null {
  if (summary.errorCode === null && summary.errorMessage === null) return null;
  return {
    status: summary.status,
    code: summary.errorCode ?? "unknown_error",
    message: summary.errorMessage,
  };
}

function selectError(left: RunSourceSummary, right: RunSourceSummary): { errorCode: string | null; errorMessage: string | null } {
  const leftError = errorCandidate(left);
  const rightError = errorCandidate(right);
  if (leftError === null) return { errorCode: right.errorCode, errorMessage: right.errorMessage };
  if (rightError === null) return { errorCode: left.errorCode, errorMessage: left.errorMessage };
  const leftPriority = STATUS_PRIORITY[leftError.status];
  const rightPriority = STATUS_PRIORITY[rightError.status];
  const leftKey = `${leftError.code}\u0000${leftError.message ?? ""}`;
  const rightKey = `${rightError.code}\u0000${rightError.message ?? ""}`;
  const selected = rightPriority > leftPriority || (rightPriority === leftPriority && rightKey < leftKey)
    ? rightError
    : leftError;
  return { errorCode: selected.code === "unknown_error" && selected.status !== "failed" ? null : selected.code, errorMessage: selected.message };
}

/** Merge repeated work on one source without depending on scheduler call order. */
export function mergeRunSourceSummaries(left: RunSourceSummary, right: RunSourceSummary): RunSourceSummary {
  if (left.sourceIdSnapshot !== right.sourceIdSnapshot) {
    throw new TypeError("Cannot merge summaries for different source IDs");
  }
  const status = STATUS_PRIORITY[right.status] > STATUS_PRIORITY[left.status] ? right.status : left.status;
  const errors = selectError(left, right);
  return {
    sourceIdSnapshot: left.sourceIdSnapshot,
    status,
    httpStatus: selectHttpStatus(left.httpStatus, right.httpStatus),
    discoveredCount: assertCount(left.discoveredCount + right.discoveredCount, "discoveredCount"),
    storedCount: assertCount(left.storedCount + right.storedCount, "storedCount"),
    errorCode: errors.errorCode,
    errorMessage: errors.errorMessage,
  };
}

function normalizeSummary(summary: RunSourceSummary): RunSourceSummary {
  if (byteLength(summary.sourceIdSnapshot) < 1 || byteLength(summary.sourceIdSnapshot) > MAX_SOURCE_ID_BYTES) {
    throw new RangeError("sourceIdSnapshot must be between 1 and 128 UTF-8 bytes");
  }
  if (!VALID_STATUSES.has(summary.status)) throw new TypeError("Invalid per-source run status");
  if (summary.httpStatus !== null && (!Number.isInteger(summary.httpStatus) || summary.httpStatus < 100 || summary.httpStatus > 599)) {
    throw new RangeError("httpStatus must be null or an HTTP status between 100 and 599");
  }
  assertCount(summary.discoveredCount, "discoveredCount");
  assertCount(summary.storedCount, "storedCount");
  return {
    ...summary,
    errorCode: sanitizeErrorCode(summary.errorCode),
    errorMessage: sanitizeErrorMessage(summary.errorMessage),
  };
}

/** Persist at most one row per source in a single bounded D1 statement. */
export async function saveRunSourceSummaries(
  db: D1Database,
  runId: string,
  summaries: RunSourceSummary[],
): Promise<void> {
  if (summaries.length === 0) return;
  if (summaries.length > MAX_RUN_SOURCE_SUMMARIES_PER_RUN) {
    throw new RangeError(`A run may persist at most ${MAX_RUN_SOURCE_SUMMARIES_PER_RUN} per-source summaries`);
  }
  if (byteLength(runId) < 1 || byteLength(runId) > MAX_SOURCE_ID_BYTES) {
    throw new RangeError("runId must be between 1 and 128 UTF-8 bytes");
  }
  const uniqueIds = new Set(summaries.map((summary) => summary.sourceIdSnapshot));
  if (uniqueIds.size !== summaries.length) throw new TypeError("Per-source summaries must have unique source IDs");

  const normalized = summaries.map(normalizeSummary);
  const valuesSql = normalized.map(() => "(?, ?, (SELECT id FROM sources WHERE id = ?), ?, ?, ?, ?, ?, ?)").join(", ");
  const bindings = normalized.flatMap((summary) => [
    runId,
    summary.sourceIdSnapshot,
    summary.sourceIdSnapshot,
    summary.status,
    summary.httpStatus,
    summary.discoveredCount,
    summary.storedCount,
    summary.errorCode,
    summary.errorMessage,
  ]);
  await db.prepare(`
    INSERT INTO fetch_run_sources (
      run_id, source_id_snapshot, source_id, status, http_status,
      discovered_count, stored_count, error_code, error_message
    ) VALUES ${valuesSql}
  `).bind(...bindings).run();
}
