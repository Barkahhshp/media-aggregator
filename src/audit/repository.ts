const OPERATOR_ACTION_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const MAX_OPERATOR_ACTION_TARGET_BYTES = 128;
const MAX_OPERATOR_ACTION_FIELDS = 16;
const MAX_OPERATOR_ACTION_FIELDS_BYTES = 2_048;

export type SourceAuditField = "kind" | "url" | "poll_interval_sec" | "selectors" | "enabled";
export type ExportAuditField =
  | "state"
  | "snapshot_id"
  | "cursor"
  | "expires_at"
  | "snapshot_sources_count"
  | "snapshot_pending_items_count"
  | "snapshot_articles_count";

export type OperatorActionInput =
  | {
      action: "source.created" | "source.updated" | "source.disabled";
      targetId: string;
      changedFields: readonly SourceAuditField[];
    }
  | {
      action: "export.started" | "export.ended";
      targetId: string;
      changedFields: readonly ExportAuditField[];
    };

const SOURCE_ACTIONS = new Set(["source.created", "source.updated", "source.disabled"]);
const SOURCE_FIELDS = new Set<SourceAuditField>(["kind", "url", "poll_interval_sec", "selectors", "enabled"]);
const EXPORT_FIELDS = new Set<ExportAuditField>([
  "state",
  "snapshot_id",
  "cursor",
  "expires_at",
  "snapshot_sources_count",
  "snapshot_pending_items_count",
  "snapshot_articles_count",
]);

export interface PrepareOperatorActionOptions {
  /** Make the insert a no-op unless the immediately preceding batch statement changed a row. */
  onlyIfPreviousStatementChanged?: boolean;
}

/**
 * Prepare a bounded, names-only audit insert for inclusion in a D1 batch.
 * D1 rolls the entire batch back if this insert fails.
 */
export function prepareOperatorAction(
  db: D1Database,
  input: OperatorActionInput,
  options: PrepareOperatorActionOptions = {},
): D1PreparedStatement {
  if (typeof input !== "object" || input === null) throw new TypeError("operator action input must be an object");
  if (typeof input.targetId !== "string") throw new TypeError("operator action target ID must be a string");
  const targetBytes = new TextEncoder().encode(input.targetId).byteLength;
  if (targetBytes < 1 || targetBytes > MAX_OPERATOR_ACTION_TARGET_BYTES) {
    throw new RangeError("operator action target ID must be between 1 and 128 UTF-8 bytes");
  }
  if (!Array.isArray(input.changedFields) || input.changedFields.length > MAX_OPERATOR_ACTION_FIELDS) {
    throw new RangeError("operator action changed fields exceed the supported bound");
  }

  const isSourceAction = SOURCE_ACTIONS.has(input.action);
  const allowedFields: ReadonlySet<string> = isSourceAction ? SOURCE_FIELDS : EXPORT_FIELDS;
  const seenFields = new Set<string>();
  for (const field of input.changedFields) {
    if (typeof field !== "string" || !allowedFields.has(field)) {
      throw new TypeError("operator actions may contain field names only");
    }
    if (seenFields.has(field)) throw new TypeError("operator action field names must be unique");
    seenFields.add(field);
  }

  const changedFieldsJson = JSON.stringify(input.changedFields);
  if (new TextEncoder().encode(changedFieldsJson).byteLength > MAX_OPERATOR_ACTION_FIELDS_BYTES) {
    throw new RangeError("operator action changed fields exceed the database limit");
  }

  const targetType = isSourceAction ? "source" : "export";
  if (options.onlyIfPreviousStatementChanged) {
    return db.prepare(`
      INSERT INTO operator_actions (action, target_type, target_id, changed_fields_json)
      SELECT ?, ?, ?, ?
      WHERE changes() > 0
    `).bind(input.action, targetType, input.targetId, changedFieldsJson);
  }
  return db.prepare(`
    INSERT INTO operator_actions (action, target_type, target_id, changed_fields_json)
    VALUES (?, ?, ?, ?)
  `).bind(input.action, targetType, input.targetId, changedFieldsJson);
}

/** Delete only operator actions strictly older than the 90-day retention window. */
export async function purgeExpiredOperatorActions(db: D1Database, now: number): Promise<number> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError("now must be a positive integer epoch timestamp");
  const result = await db.prepare(`
    DELETE FROM operator_actions
    WHERE created_at < ?
      AND created_at < unixepoch() - ?
  `).bind(now - OPERATOR_ACTION_RETENTION_SECONDS, OPERATOR_ACTION_RETENTION_SECONDS).run();
  return result.meta.changes;
}

export const OPERATOR_ACTION_DEFAULT_LIMIT = 50;
export const OPERATOR_ACTION_MAX_LIMIT = 100;

export interface OperatorActionCursor {
  createdAt: number;
  id: string;
}

export class InvalidOperatorActionCursorError extends Error {
  constructor() {
    super("Invalid operator action cursor");
    this.name = "InvalidOperatorActionCursorError";
  }
}

export interface OperatorActionRecord {
  created_at: number;
  actor: "owner";
  action: OperatorActionInput["action"];
  target_type: "source" | "export";
  target_id: string;
  changed_fields: string[];
}

interface OperatorActionRow {
  id: string;
  created_at: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  changed_fields_json: string;
}

function encodeCursor(value: OperatorActionCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, created_at: value.createdAt, id: value.id }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function encodeOperatorActionCursor(value: OperatorActionCursor): string {
  const idBytes = new TextEncoder().encode(value.id).byteLength;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || idBytes < 1 || idBytes > MAX_OPERATOR_ACTION_TARGET_BYTES) {
    throw new InvalidOperatorActionCursorError();
  }
  return encodeCursor(value);
}

export function decodeOperatorActionCursor(token: string): OperatorActionCursor {
  if (token.length === 0 || token.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new InvalidOperatorActionCursorError();
  }
  let parsed: unknown;
  try {
    const base64 = token.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InvalidOperatorActionCursorError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new InvalidOperatorActionCursorError();
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || typeof value.created_at !== "number" || typeof value.id !== "string") {
    throw new InvalidOperatorActionCursorError();
  }
  const cursor = { createdAt: value.created_at, id: value.id };
  const idBytes = new TextEncoder().encode(cursor.id).byteLength;
  if (!Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 || idBytes < 1 || idBytes > MAX_OPERATOR_ACTION_TARGET_BYTES) {
    throw new InvalidOperatorActionCursorError();
  }
  return cursor;
}

function changedFieldNames(row: OperatorActionRow): string[] {
  const allowed: ReadonlySet<string> = row.action.startsWith("source.") ? SOURCE_FIELDS : EXPORT_FIELDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.changed_fields_json) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((field): field is string => typeof field === "string" && allowed.has(field)))];
}

export async function listOperatorActions(
  db: D1Database,
  limit: number,
  now: number,
  cursor?: OperatorActionCursor,
): Promise<{ actions: OperatorActionRecord[]; nextCursor: string | null }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPERATOR_ACTION_MAX_LIMIT) {
    throw new RangeError("limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError("now must be a positive integer epoch timestamp");
  const predicates = ["created_at >= ?", "created_at <= ?"];
  const bindings: unknown[] = [now - OPERATOR_ACTION_RETENTION_SECONDS, now];
  if (cursor !== undefined) {
    predicates.push("(created_at < ? OR (created_at = ? AND id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(limit);
  const result = await db.prepare(`
    SELECT id, created_at, actor, action, target_type, target_id, changed_fields_json
    FROM operator_actions
    WHERE ${predicates.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(...bindings).all<OperatorActionRow>();
  const rows = result.results;
  const actions = rows.map((row) => ({
    created_at: Number(row.created_at),
    actor: "owner" as const,
    action: row.action as OperatorActionInput["action"],
    target_type: row.target_type as "source" | "export",
    target_id: row.target_id,
    changed_fields: changedFieldNames(row),
  }));
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    actions,
    nextCursor: last ? encodeOperatorActionCursor({ createdAt: Number(last.created_at), id: last.id }) : null,
  };
}
