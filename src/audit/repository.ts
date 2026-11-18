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
