import { checkWriteGate, completeWriteReservation } from "../ingest/storage-guard.ts";
import { prepareOperatorAction } from "../audit/repository.ts";

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_LOCK_SECONDS = 30 * 60;
export const EXPORT_PAGE_RECORD_LIMIT = 10;
export const EXPORT_PAGE_MAX_BYTES = 3 * 1024 * 1024;

const DATA_RECORD_LIMIT = EXPORT_PAGE_RECORD_LIMIT - 1;
const TABLES = [
  { type: "source", table: "sources" },
  { type: "pending", table: "pending_items" },
  { type: "article", table: "articles" },
] as const;

type ExportRecordType = (typeof TABLES)[number]["type"];
type CursorTable = (typeof TABLES)[number]["table"];

interface ExportCursor {
  snapshot_id: string;
  table: CursorTable;
  id: string;
}

export interface ExportSession {
  id: string;
  snapshot_id: string;
  export_watermark: string;
  cursor: string | null;
  expires_at: number;
  state: "active" | "completed" | "expired";
  created_at: number;
  updated_at: number;
  counts: ExportCounts;
}

export interface ExportRecord {
  type: ExportRecordType;
  record: Record<string, unknown>;
}

export interface ExportCounts {
  sources: number;
  pending_items: number;
  articles: number;
}

export interface ExportManifest {
  type: "manifest";
  schema_version: number;
  snapshot_id: string;
  export_watermark: string;
  exported_at: number;
  counts: ExportCounts;
  full_text_encoding: "base64-utf8";
  next_cursor: string | null;
}

export interface ExportPage {
  ndjson: string;
  record_count: number;
  byte_count: number;
  next_cursor: string | null;
}

export class ExportRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ExportRepositoryError";
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid");
  }
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid");
  }
}

function encodeCursor(cursor: ExportCursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

function decodeCursor(value: string, snapshotId: string): ExportCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof ExportRepositoryError) throw error;
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid");
  }
  if (payload === null || typeof payload !== "object") {
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid");
  }
  const candidate = payload as Partial<ExportCursor>;
  const validTable = TABLES.some((item) => item.table === candidate.table);
  if (
    !validTable ||
    candidate.snapshot_id !== snapshotId ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 128
  ) {
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid or belongs to another snapshot");
  }
  return candidate as ExportCursor;
}

function fullTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function serializeRecord(type: ExportRecordType, row: Record<string, unknown>): ExportRecord {
  if (type !== "article") return { type, record: row };
  const { content_text: contentText, ...metadata } = row;
  if (typeof contentText !== "string") {
    throw new ExportRepositoryError(500, "invalid_article_row", "An article is missing its stored text");
  }
  return {
    type,
    record: { ...metadata, content_text_base64: fullTextToBase64(contentText) },
  };
}

function pageText(manifest: ExportManifest, records: ExportRecord[]): string {
  return `${[JSON.stringify(manifest), ...records.map((record) => JSON.stringify(record))].join("\n")}\n`;
}

function sessionFromRow(row: Record<string, unknown> | null): ExportSession | null {
  if (!row) return null;
  return {
    id: String(row.id),
    snapshot_id: String(row.snapshot_id),
    export_watermark: String(row.export_watermark),
    cursor: typeof row.cursor === "string" ? row.cursor : null,
    expires_at: Number(row.expires_at),
    state: String(row.state) as ExportSession["state"],
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    counts: {
      sources: Number(row.snapshot_sources_count ?? 0),
      pending_items: Number(row.snapshot_pending_items_count ?? 0),
      articles: Number(row.snapshot_articles_count ?? 0),
    },
  };
}

export async function getExportSession(db: D1Database, id: string): Promise<ExportSession | null> {
  const row = await db.prepare(`
    SELECT id, snapshot_id, export_watermark, cursor, expires_at, state, created_at, updated_at,
      snapshot_sources_count, snapshot_pending_items_count, snapshot_articles_count
    FROM export_sessions WHERE id = ? LIMIT 1
  `).bind(id).first<Record<string, unknown>>();
  return sessionFromRow(row);
}

export async function getActiveExportSession(db: D1Database, now = nowSeconds()): Promise<ExportSession | null> {
  const row = await db.prepare(`
    SELECT session.id, session.snapshot_id, session.export_watermark, session.cursor,
      MIN(session.expires_at, state.export_lock_expires_at) AS expires_at,
      session.state, session.created_at, session.updated_at,
      session.snapshot_sources_count, session.snapshot_pending_items_count, session.snapshot_articles_count
    FROM export_sessions AS session
    JOIN system_state AS state
      ON state.singleton_id = 'global'
      AND state.export_lock = 1
      AND state.export_lock_id = session.id
      AND state.export_lock_expires_at > ?
    WHERE session.state = 'active' AND session.expires_at > ?
    LIMIT 1
  `).bind(now, now).first<Record<string, unknown>>();
  return sessionFromRow(row);
}

export async function startExport(db: D1Database, now = nowSeconds()): Promise<ExportSession> {
  const id = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const exportWatermark = String(now);
  const expiresAt = now + EXPORT_LOCK_SECONDS;
  const reservation = await checkWriteGate(db, "run", 4 * 1024, crypto.randomUUID(), now);
  if (reservation === "storage_limit") {
    throw new ExportRepositoryError(503, "storage_limit", "Exports are paused because storage is full");
  }
  let latestSize = reservation.measuredSize;
  try {
    const results = await db.batch([
      db.prepare(`
        DELETE FROM export_sessions
        WHERE state IN ('completed', 'expired', 'aborted') OR (state = 'active' AND expires_at <= ?)
      `).bind(now),
      db.prepare(`
      UPDATE system_state
      SET export_lock = 1, export_lock_id = ?, export_lock_expires_at = ?, updated_at = ?
      WHERE singleton_id = 'global'
        AND (export_lock = 0 OR export_lock_expires_at IS NULL OR export_lock_expires_at <= ?)
        AND (global_lease_token IS NULL OR global_lease_expires_at IS NULL OR global_lease_expires_at <= ?)
      RETURNING export_lock_id
      `).bind(id, expiresAt, now, now, now),
      db.prepare(`
      INSERT INTO export_sessions (id, snapshot_id, export_watermark, cursor, expires_at, state, created_at, updated_at)
      SELECT ?, ?, ?, NULL, ?, 'active', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM system_state
        WHERE singleton_id = 'global' AND export_lock = 1 AND export_lock_id = ?
      )
      RETURNING id
      `).bind(id, snapshotId, exportWatermark, expiresAt, now, now, id),
      db.prepare(`
      UPDATE export_sessions
      SET snapshot_sources_count = (SELECT COUNT(*) FROM sources),
          snapshot_pending_items_count = (SELECT COUNT(*) FROM pending_items),
          snapshot_articles_count = (SELECT COUNT(*) FROM articles)
      WHERE id = ? AND state = 'active'
      RETURNING snapshot_sources_count AS sources,
        snapshot_pending_items_count AS pending_items,
        snapshot_articles_count AS articles
      `).bind(id),
      prepareOperatorAction(db, {
        action: "export.started",
        targetId: id,
        changedFields: [
          "state",
          "snapshot_id",
          "cursor",
          "expires_at",
          "snapshot_sources_count",
          "snapshot_pending_items_count",
          "snapshot_articles_count",
        ],
      }, { onlyIfPreviousStatementChanged: true }),
    ]);
    latestSize = results.reduce((largest, result) => Math.max(largest, result.meta.size_after ?? reservation.measuredSize), reservation.measuredSize);
    const acquired = results[1]?.results?.[0] as { export_lock_id?: string } | undefined;
    const inserted = results[2]?.results?.[0] as { id?: string } | undefined;
    const snapshotCounts = results[3]?.results?.[0] as ExportCounts | undefined;
    if (acquired?.export_lock_id !== id || inserted?.id !== id) {
      const systemState = await db.prepare(`
        SELECT export_lock, export_lock_expires_at, global_lease_token, global_lease_expires_at
        FROM system_state WHERE singleton_id = 'global' LIMIT 1
      `).first<Record<string, unknown>>();
      const liveExport = Number(systemState?.export_lock) === 1 && Number(systemState?.export_lock_expires_at ?? 0) > now;
      if (liveExport) {
        throw new ExportRepositoryError(423, "export_in_progress", "Another export currently holds the export lock");
      }
      throw new ExportRepositoryError(409, "ingestion_in_progress", "Wait for the active ingestion lease to finish before exporting");
    }
    return {
      id,
      snapshot_id: snapshotId,
      export_watermark: exportWatermark,
      cursor: null,
      expires_at: expiresAt,
      state: "active",
      created_at: now,
      updated_at: now,
      counts: {
        sources: Number(snapshotCounts?.sources ?? 0),
        pending_items: Number(snapshotCounts?.pending_items ?? 0),
        articles: Number(snapshotCounts?.articles ?? 0),
      },
    };
  } finally {
    await completeWriteReservation(db, reservation.id, latestSize, now);
  }
}

async function markExpiredAndRelease(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare(`
      UPDATE system_state
      SET export_lock = 0, export_lock_id = NULL, export_lock_expires_at = NULL, updated_at = ?
      WHERE singleton_id = 'global' AND export_lock_id = ?
    `).bind(now, sessionId),
    db.prepare("DELETE FROM export_sessions WHERE id = ? AND state = 'active'")
      .bind(sessionId),
  ]);
}

async function assertSessionActive(db: D1Database, session: ExportSession, now: number): Promise<ExportSession> {
  const stored = await getExportSession(db, session.id);
  if (!stored || stored.snapshot_id !== session.snapshot_id) {
    throw new ExportRepositoryError(404, "export_not_found", "The export session was not found");
  }
  if (stored.state !== "active") {
    throw new ExportRepositoryError(410, "export_expired", "The export session is no longer active");
  }
  if (stored.expires_at <= now) {
    await markExpiredAndRelease(db, stored.id, now);
    throw new ExportRepositoryError(410, "export_expired", "The export lock expired; start a new export");
  }
  const lock = await db.prepare(`
    SELECT export_lock, export_lock_id, export_lock_expires_at
    FROM system_state WHERE singleton_id = 'global' LIMIT 1
  `).first<Record<string, unknown>>();
  if (
    Number(lock?.export_lock) !== 1 ||
    lock?.export_lock_id !== stored.id ||
    Number(lock?.export_lock_expires_at ?? 0) <= now
  ) {
    await markExpiredAndRelease(db, stored.id, now);
    throw new ExportRepositoryError(410, "export_expired", "The export lock is no longer active; start a new export");
  }
  return stored;
}

async function hasRowsAfter(db: D1Database, last: ExportCursor): Promise<boolean> {
  const currentIndex = TABLES.findIndex((item) => item.table === last.table);
  for (let index = currentIndex; index < TABLES.length; index += 1) {
    const item = TABLES[index];
    if (!item) continue;
    const afterId = index === currentIndex ? last.id : "";
    const next = await db.prepare(`SELECT id FROM ${item.table} WHERE id > ? ORDER BY id LIMIT 1`)
      .bind(afterId).first<{ id: string }>();
    if (next) return true;
  }
  return false;
}

export async function getExportPage(
  db: D1Database,
  session: ExportSession,
  cursor: string | null,
  now = nowSeconds(),
): Promise<ExportPage> {
  const activeSession = await assertSessionActive(db, session, now);
  const cursorPayload = cursor === null
    ? { snapshot_id: activeSession.snapshot_id, table: "sources" as const, id: "" }
    : decodeCursor(cursor, activeSession.snapshot_id);
  const startingIndex = TABLES.findIndex((item) => item.table === cursorPayload.table);
  if (startingIndex < 0) {
    throw new ExportRepositoryError(400, "invalid_export_cursor", "The export cursor is invalid");
  }

  const counts = activeSession.counts;
  const records: ExportRecord[] = [];
  let last: ExportCursor | null = null;
  let stop = false;

  for (let tableIndex = startingIndex; tableIndex < TABLES.length && !stop; tableIndex += 1) {
    const tableInfo = TABLES[tableIndex];
    if (!tableInfo) continue;
    const remaining = DATA_RECORD_LIMIT - records.length;
    if (remaining <= 0) break;
    const afterId = tableIndex === startingIndex ? cursorPayload.id : "";
    const rows = await db.prepare(`SELECT * FROM ${tableInfo.table} WHERE id > ? ORDER BY id LIMIT ?`)
      .bind(afterId, remaining).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const record = serializeRecord(tableInfo.type, row);
      const position: ExportCursor = {
        snapshot_id: activeSession.snapshot_id,
        table: tableInfo.table,
        id: String(row.id),
      };
      const trialManifest: ExportManifest = {
        type: "manifest",
        schema_version: EXPORT_SCHEMA_VERSION,
        snapshot_id: activeSession.snapshot_id,
        export_watermark: activeSession.export_watermark,
        exported_at: activeSession.created_at,
        counts,
        full_text_encoding: "base64-utf8",
        next_cursor: encodeCursor(position),
      };
      const trialText = pageText(trialManifest, [...records, record]);
      if (new TextEncoder().encode(trialText).byteLength > EXPORT_PAGE_MAX_BYTES) {
        if (records.length === 0) {
          throw new ExportRepositoryError(500, "export_record_too_large", "A record cannot fit within the export page byte limit");
        }
        stop = true;
        break;
      }
      records.push(record);
      last = position;
      if (records.length >= DATA_RECORD_LIMIT) {
        stop = true;
        break;
      }
    }
    if ((rows.results?.length ?? 0) < remaining) continue;
    if (records.length >= DATA_RECORD_LIMIT) stop = true;
  }

  const more = last === null ? false : await hasRowsAfter(db, last);
  const nextCursor = more && last !== null ? encodeCursor(last) : null;
  const manifest: ExportManifest = {
    type: "manifest",
    schema_version: EXPORT_SCHEMA_VERSION,
    snapshot_id: activeSession.snapshot_id,
    export_watermark: activeSession.export_watermark,
    exported_at: activeSession.created_at,
    counts,
    full_text_encoding: "base64-utf8",
    next_cursor: nextCursor,
  };
  const ndjson = pageText(manifest, records);
  const byteCount = new TextEncoder().encode(ndjson).byteLength;
  if (records.length + 1 > EXPORT_PAGE_RECORD_LIMIT || byteCount > EXPORT_PAGE_MAX_BYTES) {
    throw new ExportRepositoryError(500, "export_page_limit_exceeded", "The export page exceeded its configured safety limits");
  }
  const updated = await db.prepare(`
    UPDATE export_sessions SET cursor = ?, updated_at = ?
    WHERE id = ? AND state = 'active' AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM system_state WHERE singleton_id = 'global'
          AND export_lock = 1 AND export_lock_id = ? AND export_lock_expires_at > ?
      )
  `).bind(nextCursor, now, activeSession.id, now, activeSession.id, now).run();
  if (Number(updated.meta.changes ?? 0) === 0) {
    throw new ExportRepositoryError(410, "export_expired", "The export lock expired while building this page");
  }
  return {
    ndjson,
    record_count: records.length + 1,
    byte_count: byteCount,
    next_cursor: nextCursor,
  };
}

export async function endExport(db: D1Database, sessionId: string, now = nowSeconds()): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      UPDATE system_state
      SET export_lock = 0, export_lock_id = NULL, export_lock_expires_at = NULL, updated_at = ?
      WHERE singleton_id = 'global' AND export_lock = 1 AND export_lock_id = ?
        AND export_lock_expires_at > ?
        AND EXISTS (
          SELECT 1 FROM export_sessions
          WHERE id = ? AND state = 'active' AND expires_at > ?
        )
      RETURNING singleton_id
    `).bind(now, sessionId, now, sessionId, now),
    db.prepare(`
      DELETE FROM export_sessions
      WHERE id = ? AND state = 'active' AND expires_at > ? AND changes() > 0
      RETURNING id
    `).bind(sessionId, now),
    prepareOperatorAction(db, {
      action: "export.ended",
      targetId: sessionId,
      changedFields: ["state", "expires_at"],
    }, { onlyIfPreviousStatementChanged: true }),
  ]);
  const deletedId = (results[1]?.results?.[0] as { id?: string } | undefined)?.id;
  return deletedId === sessionId && Number(results[2]?.meta.changes ?? 0) > 0;
}
