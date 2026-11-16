import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizePublishedAt } from "./feed-parser";
import { MAX_SOURCE_CURSOR_BYTES, stableCursorValue } from "./cursor";
import { checkWriteGate, completeWriteReservation, D1_STORAGE_STOP_BYTES } from "./storage-guard";
import type { Candidate, SourceCursor } from "./types";
import type { Source } from "../sources/types";

export const MAX_PENDING_ROWS = 2_000;
export const MAX_PENDING_METADATA_BYTES = 24 * 1024 * 1024;
export const MAX_PENDING_INSERTS_PER_CALL = 10;
export const MAX_PENDING_CHECKS_PER_CALL = 25;
export const PENDING_LEASE_SECONDS = 120;
export const TERMINAL_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const MAX_DEDUPE_KEY_BYTES = 4 * 1024;
const MAX_EXTERNAL_ID_BYTES = 1024;
const MAX_URL_BYTES = 4 * 1024;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_SUMMARY_BYTES = 1024;
const MAX_PUBLISHED_AT_BYTES = 64;
const MAX_ERROR_BYTES = 1024;
const ESTIMATED_PENDING_GROWTH_PER_CANDIDATE_BYTES = 64 * 1024;
const PENDING_HASH_PREFIX = "__cue_pending_sha256_v1__:";
const OVERFLOW_URL_PREFIX = "https://metadata.invalid/sha256/";

export interface PendingBudget {
  /** Scheduler timestamp used to make newly discovered rows immediately eligible. */
  now?: number;
  /** Maximum number of new rows inserted by this call. Defaults to 10. */
  maxCandidates?: number;
  /** Maximum number of candidates, including dedupe hits, checked by this call. */
  maxChecks?: number;
  /** Total backlog row cap. Defaults to 2,000. */
  maxTotalRows?: number;
  /** Total serialized metadata byte cap. Defaults to 24 MiB. */
  maxSerializedBytes?: number;
}

export interface EnqueueResult {
  inserted: number;
  deduplicated: number;
  failed: number;
  blocked: number;
  lastAccountedCursor: SourceCursor | null;
  hasMore: boolean;
  stopReason: "max_candidates" | "query_limit" | "pending_limit" | "metadata_limit" | "storage_limit" | "invalid_cursor" | "unsupported_source" | null;
}

export interface PendingItem {
  id: string;
  source_id: string;
  item_type: "article" | "sitemap";
  dedupe_key: string;
  external_id: string | null;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  published_at: string | null;
  status: "pending" | "leased" | "retry_wait" | "blocked" | "failed";
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  terminal_expires_at: number | null;
  discovered_at: number;
  created_at: number;
  updated_at: number;
}

export type PendingFailure =
  | { kind: "retryable"; nextAttemptAt: number; code: string; message: string }
  | { kind: "terminal"; status: "blocked" | "failed"; now: number; code: string; message: string };

interface PendingCandidate extends Candidate {
  pendingType?: "article" | "sitemap";
  terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
}

interface PreparedCandidate {
  candidate: PendingCandidate;
  sourceId: string;
  itemType: "article" | "sitemap";
  dedupeKey: string;
  externalId: string | null;
  canonicalUrl: string;
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  status: "pending" | "blocked" | "failed";
  lastError: string | null;
  terminalExpiresAt: number | null;
  serializedBytes: number;
}

function bytes(value: string | null): number {
  return value === null ? 0 : new TextEncoder().encode(value).byteLength;
}

function hashIdentity(identity: string): string {
  return `${PENDING_HASH_PREFIX}${bytesToHex(sha256(new TextEncoder().encode(identity)))}`;
}

function overflowUrl(originalUrl: string): string {
  return `${OVERFLOW_URL_PREFIX}${bytesToHex(sha256(new TextEncoder().encode(originalUrl)))}`;
}

function prepareCandidate(source: Source, candidate: PendingCandidate, now: number): PreparedCandidate {
  const tooLongExternalId = bytes(candidate.externalId) > MAX_EXTERNAL_ID_BYTES;
  const tooLongDedupeKey = bytes(candidate.dedupeKey) > MAX_DEDUPE_KEY_BYTES;
  const tooLongUrl = bytes(candidate.canonicalUrl) > MAX_URL_BYTES;
  const tooLongTitle = bytes(candidate.title) > MAX_TITLE_BYTES;
  const tooLongSummary = bytes(candidate.summary) > MAX_SUMMARY_BYTES;
  const tooLongPublishedAt = bytes(candidate.publishedAt) > MAX_PUBLISHED_AT_BYTES;
  const metadataTooLarge = tooLongExternalId || tooLongDedupeKey || tooLongUrl || tooLongTitle || tooLongSummary || tooLongPublishedAt;
  const rawIdentity = candidate.dedupeKey || candidate.externalId || candidate.canonicalUrl;
  const dedupeKey = tooLongExternalId || tooLongDedupeKey || tooLongUrl || rawIdentity.startsWith(PENDING_HASH_PREFIX)
    ? hashIdentity(rawIdentity)
    : rawIdentity;
  const externalId = tooLongExternalId ? null : candidate.externalId;
  const canonicalUrl = tooLongUrl ? overflowUrl(candidate.canonicalUrl) : candidate.canonicalUrl;
  const title = tooLongTitle ? null : candidate.title;
  const summary = tooLongSummary ? null : candidate.summary;
  const publishedAt = tooLongPublishedAt ? null : normalizePublishedAt(candidate.publishedAt);
  let status: PreparedCandidate["status"] = "pending";
  let lastError: string | null = null;
  if (candidate.terminalFailure !== undefined) {
    status = candidate.terminalFailure.status;
    lastError = `${candidate.terminalFailure.code}: ${candidate.terminalFailure.message}`;
  } else if (metadataTooLarge) {
    status = "failed";
    lastError = "metadata_too_large";
  }
  const terminalExpiresAt = status === "pending" ? null : now + TERMINAL_RETENTION_SECONDS;
  const safeLastError = lastError === null ? null : truncateUtf8(lastError, MAX_ERROR_BYTES);
  const prepared: Omit<PreparedCandidate, "serializedBytes"> = {
    candidate,
    sourceId: source.id,
    itemType: candidate.pendingType ?? "article",
    dedupeKey,
    externalId,
    canonicalUrl,
    title,
    summary,
    publishedAt,
    status,
    lastError: safeLastError,
    terminalExpiresAt,
  };
  const metadata = {
    source_id: prepared.sourceId,
    dedupe_key: prepared.dedupeKey,
    external_id: prepared.externalId,
    canonical_url: prepared.canonicalUrl,
    title: prepared.title,
    summary: prepared.summary,
    published_at: prepared.publishedAt,
    last_error: prepared.lastError,
  };
  return { ...prepared, serializedBytes: new TextEncoder().encode(JSON.stringify(metadata)).byteLength };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (currentBytes + characterBytes > maxBytes) break;
    result += character;
    currentBytes += characterBytes;
  }
  return result;
}

function cursorColumn(source: Source, cursor: SourceCursor): "feed_watermark" | "sitemap_last_loc" | null {
  if (source.kind === "feed" && cursor.kind === "feed") return "feed_watermark";
  if (source.kind === "sitemap" && cursor.kind === "sitemap") return "sitemap_last_loc";
  return null;
}

function cursorUpdateStatement(db: D1Database, source: Source, prepared: PreparedCandidate): D1PreparedStatement | null {
  const cursor = prepared.candidate.sourceCursor;
  if (cursor === null) return null;
  const column = cursorColumn(source, cursor);
  const expectedCursor = stableCursorValue(prepared.candidate.dedupeKey);
  if (column === null || bytes(expectedCursor) > MAX_SOURCE_CURSOR_BYTES || cursor.value !== expectedCursor) return null;
  const safeCursor = expectedCursor;
  return db.prepare(
    `UPDATE sources
     SET ${column} = ?, updated_at = ?
     WHERE id = ? AND (
       EXISTS (SELECT 1 FROM pending_items WHERE source_id = ? AND dedupe_key = ?)
       OR EXISTS (
         SELECT 1 FROM articles
         WHERE source_id = ? AND (
           (? IS NOT NULL AND external_id = ?) OR canonical_url = ?
         )
       )
     )
     RETURNING id`,
  ).bind(
    safeCursor,
    Math.floor(Date.now() / 1000),
    source.id,
    source.id,
    prepared.dedupeKey,
    source.id,
    prepared.externalId,
    prepared.externalId,
    prepared.canonicalUrl,
  );
}

function directCandidateAccountedStatement(db: D1Database, prepared: PreparedCandidate): D1PreparedStatement {
  return db.prepare(`
    SELECT 1 AS accounted
    WHERE EXISTS (SELECT 1 FROM pending_items WHERE source_id = ? AND dedupe_key = ?)
       OR EXISTS (
         SELECT 1 FROM articles
         WHERE source_id = ? AND ((? IS NOT NULL AND external_id = ?) OR canonical_url = ?)
       )
  `).bind(
    prepared.sourceId,
    prepared.dedupeKey,
    prepared.sourceId,
    prepared.externalId,
    prepared.externalId,
    prepared.canonicalUrl,
  );
}

async function pendingStats(db: D1Database): Promise<{ count: number; bytes: number }> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(length(CAST(json_object(
      'source_id', source_id,
      'dedupe_key', dedupe_key,
      'external_id', external_id,
      'canonical_url', canonical_url,
      'title', title,
      'summary', summary,
      'published_at', published_at,
      'last_error', last_error
    ) AS BLOB))), 0) AS bytes
    FROM pending_items
  `).first<{ count: number; bytes: number }>();
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}

export async function enqueueCandidates(
  db: D1Database,
  source: Source,
  candidates: Candidate[],
  budget: PendingBudget,
): Promise<EnqueueResult> {
  const result: EnqueueResult = {
    inserted: 0,
    deduplicated: 0,
    failed: 0,
    blocked: 0,
    lastAccountedCursor: null,
    hasMore: false,
    stopReason: null,
  };
  if (source.kind !== "feed" && source.kind !== "sitemap" && source.kind !== "article" && source.kind !== "html_list") {
    result.hasMore = candidates.length > 0;
    result.stopReason = candidates.length > 0 ? "unsupported_source" : null;
    return result;
  }

  const maxNewRows = Math.max(0, Math.min(MAX_PENDING_INSERTS_PER_CALL, budget.maxCandidates ?? MAX_PENDING_INSERTS_PER_CALL));
  const maxTotalRows = Math.max(0, Math.min(MAX_PENDING_ROWS, budget.maxTotalRows ?? MAX_PENDING_ROWS));
  const maxBytes = Math.max(0, Math.min(MAX_PENDING_METADATA_BYTES, budget.maxSerializedBytes ?? MAX_PENDING_METADATA_BYTES));
  const now = budget.now ?? Math.floor(Date.now() / 1000);
  const maxChecks = Math.max(0, Math.min(MAX_PENDING_CHECKS_PER_CALL, budget.maxChecks ?? MAX_PENDING_CHECKS_PER_CALL));
  const candidatesToCheck = Math.min(candidates.length, maxChecks);
  if (candidatesToCheck === 0) return result;

  const reservation = await checkWriteGate(
    db,
    "pending",
    candidatesToCheck * ESTIMATED_PENDING_GROWTH_PER_CANDIDATE_BYTES,
  );
  if (reservation === "storage_limit") {
    result.hasMore = true;
    result.stopReason = "storage_limit";
    return result;
  }

  let latestSize = reservation.measuredSize;
  try {
    for (let index = 0; index < candidatesToCheck; index += 1) {
      const candidate = candidates[index] as PendingCandidate;
      const prepared = prepareCandidate(source, candidate, now);
      const cursor = candidate.sourceCursor;
      const cursorUpdate = cursor === null && (source.kind === "article" || source.kind === "html_list")
        ? directCandidateAccountedStatement(db, prepared)
        : cursorUpdateStatement(db, source, prepared);
      if (cursorUpdate === null) {
        result.hasMore = true;
        result.stopReason = "invalid_cursor";
        break;
      }
      const insert = db.prepare(`
      INSERT OR IGNORE INTO pending_items (
        id, source_id, item_type, dedupe_key, external_id, canonical_url,
        title, summary, published_at, status, next_attempt_at, last_error, terminal_expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM pending_items) < ?
        AND COALESCE((
          SELECT SUM(length(CAST(json_object(
            'source_id', source_id,
            'dedupe_key', dedupe_key,
            'external_id', external_id,
            'canonical_url', canonical_url,
            'title', title,
            'summary', summary,
            'published_at', published_at,
            'last_error', last_error
          ) AS BLOB)))
          FROM pending_items
        ), 0) + ? <= ?
        AND (
          ? < ?
          OR EXISTS (SELECT 1 FROM pending_items WHERE source_id = ? AND dedupe_key = ?)
          OR EXISTS (SELECT 1 FROM articles WHERE source_id = ? AND ((? IS NOT NULL AND external_id = ?) OR canonical_url = ?))
        )
        AND NOT EXISTS (
          SELECT 1 FROM articles
          WHERE source_id = ? AND ((? IS NOT NULL AND external_id = ?) OR canonical_url = ?)
        )
      RETURNING id
    `).bind(
      crypto.randomUUID(),
      prepared.sourceId,
      prepared.itemType,
      prepared.dedupeKey,
      prepared.externalId,
      prepared.canonicalUrl,
      prepared.title,
      prepared.summary,
      prepared.publishedAt,
      prepared.status,
      now,
      prepared.lastError,
      prepared.terminalExpiresAt,
      maxTotalRows,
      prepared.serializedBytes,
      maxBytes,
      result.inserted,
      maxNewRows,
      source.id,
      prepared.dedupeKey,
      source.id,
      prepared.externalId,
      prepared.externalId,
      prepared.canonicalUrl,
      source.id,
      prepared.externalId,
      prepared.externalId,
      prepared.canonicalUrl,
    );

      const batch = await db.batch([insert, cursorUpdate]);
      latestSize = batch[1]?.meta.size_after ?? batch[0]?.meta.size_after ?? latestSize;
      const inserted = (batch[0]?.results?.length ?? 0) > 0;
      const accounted = inserted || (batch[1]?.results?.length ?? 0) > 0;
      if (!inserted && !accounted) {
        const stats = await pendingStats(db);
        result.hasMore = true;
        if (stats.count >= maxTotalRows) result.stopReason = "pending_limit";
        else if (stats.bytes + prepared.serializedBytes > maxBytes) result.stopReason = "metadata_limit";
        else if (result.inserted >= maxNewRows) result.stopReason = "max_candidates";
        else result.stopReason = "invalid_cursor";
        break;
      }
      if (!accounted) {
        result.hasMore = true;
        result.stopReason = "invalid_cursor";
        break;
      }

      if (inserted) {
        result.inserted += 1;
        if (prepared.status === "failed") result.failed += 1;
        if (prepared.status === "blocked") result.blocked += 1;
      } else {
        result.deduplicated += 1;
      }
      if (cursor !== null) result.lastAccountedCursor = { kind: cursor.kind, value: cursor.value };
      if (latestSize >= D1_STORAGE_STOP_BYTES) {
        result.stopReason = "storage_limit";
        result.hasMore = index + 1 < candidates.length || candidates.length > candidatesToCheck;
        break;
      }
    }
    if (result.stopReason === null && candidates.length > candidatesToCheck) {
      result.hasMore = true;
      result.stopReason = "query_limit";
    }
    if (result.stopReason === "pending_limit" || result.stopReason === "metadata_limit") {
      const status = await db.prepare("UPDATE sources SET last_status = 'storage_limit', updated_at = ? WHERE id = ?")
        .bind(now, source.id)
        .run();
      latestSize = status.meta.size_after;
      if (latestSize >= D1_STORAGE_STOP_BYTES) result.stopReason = "storage_limit";
    }
  } finally {
    await completeWriteReservation(db, reservation.id, latestSize);
  }
  return result;
}

export async function claimPending(
  db: D1Database,
  now: number,
  leaseToken: string,
  itemType?: PendingItem["item_type"],
): Promise<PendingItem | null> {
  const reservation = await checkWriteGate(db, "pending", 2 * 1024);
  if (reservation === "storage_limit") return null;
  const leaseExpiresAt = now + PENDING_LEASE_SECONDS;
  let sizeAfter = reservation.measuredSize;
  try {
    const result = await db.prepare(`
      UPDATE pending_items
      SET status = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM pending_items
        WHERE (
          (status IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?)
        ) AND (? IS NULL OR item_type = ?)
        ORDER BY discovered_at ASC, id ASC
        LIMIT 1
      )
      RETURNING *
    `).bind(leaseToken, leaseExpiresAt, now, now, now, itemType ?? null, itemType ?? null).run<PendingItem>();
    sizeAfter = result.meta.size_after;
    if (sizeAfter >= D1_STORAGE_STOP_BYTES) return null;
    return result.results?.[0] ?? null;
  } finally {
    await completeWriteReservation(db, reservation.id, sizeAfter, now);
  }
}

export async function markPendingFailure(db: D1Database, item: PendingItem, outcome: PendingFailure): Promise<void> {
  const now = outcome.kind === "terminal" ? outcome.now : Math.floor(Date.now() / 1000);
  const error = truncateUtf8(`${outcome.code}: ${outcome.message}`, MAX_ERROR_BYTES);
  const terminal = outcome.kind === "terminal";
  const status = terminal ? outcome.status : "retry_wait";
  const nextAttemptAt = terminal ? now : outcome.nextAttemptAt;
  const terminalExpiresAt = terminal ? now + TERMINAL_RETENTION_SECONDS : null;
  const reservation = await checkWriteGate(db, "pending", 2 * 1024);
  if (reservation === "storage_limit") throw new Error("Pending failure write stopped by storage_limit");
  let sizeAfter = reservation.measuredSize;
  try {
    const result = await db.prepare(`
      UPDATE pending_items
      SET status = ?, attempts = attempts + 1, next_attempt_at = ?, last_error = ?,
          terminal_expires_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
      RETURNING id
    `).bind(status, nextAttemptAt, error, terminalExpiresAt, now, item.id, item.lease_token, now).run<{ id: string }>();
    sizeAfter = result.meta.size_after;
    if ((result.results?.length ?? 0) === 0) throw new Error("Pending lease is no longer valid");
  } finally {
    await completeWriteReservation(db, reservation.id, sizeAfter, now);
  }
}

export async function purgeExpiredTerminalItems(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM pending_items
    WHERE status IN ('blocked', 'failed') AND terminal_expires_at <= ?
  `).bind(now).run();
  return result.meta.changes;
}
