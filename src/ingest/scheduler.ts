import type { Env } from "../env";
import { getSource } from "../sources/repository";
import type { Source } from "../sources/types";
import { discoverHtmlList, discoverSource } from "./discovery";
import { extractArticle } from "./html-extractor";
import { fetchPendingDocument, fetchSourceDocument } from "./fetch-source";
import { claimPending, enqueueCandidates, markPendingFailure, purgeExpiredTerminalItems } from "./pending-repository";
import type { PendingItem } from "./pending-repository";
import { saveArticleAndCompletePending } from "./article-store";
import type { Candidate } from "./types";
import { checkWriteGate, completeWriteReservation, D1_STORAGE_STOP_BYTES } from "./storage-guard";
import type { WriteReservation } from "./storage-guard";

export const MAX_D1_QUERIES_PER_INVOCATION = 50;
export const GLOBAL_LEASE_SECONDS = 60;
const FINALIZATION_D1_QUERY_RESERVE = 5;
const RUN_WRITE_RESERVATION_BYTES = 16 * 1024;
const SOURCE_WRITE_RESERVATION_BYTES = 4 * 1024;
const ARTICLE_FETCH_LIMIT = 2;
const DISCOVERY_NEW_CANDIDATE_LIMIT = 10;
const DISCOVERY_CHECK_LIMIT = 10;
const BACKLOG_SOURCE_DEFERRAL_COUNT = 2;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const MAX_CONDITIONAL_HEADER_BYTES = 1024;

export interface ScheduleResult {
  status: "succeeded" | "partial" | "failed" | "blocked" | "storage_limit" | "export_locked" | "lease_busy";
  sourcesProcessed: number;
  sourceFetches: number;
  articleFetches: number;
  sitemapFetches: number;
  discovered: number;
  stored: number;
  d1Queries: number;
  errorCode: string | null;
  httpStatus: number | null;
}

interface QueryBudget {
  db: D1Database;
  count(): number;
  beforeFetch(): void;
  beginFinalization(): void;
}

function withQueryBudget(db: D1Database): QueryBudget {
  let queryCount = 0;
  let outboundCount = 0;
  let finalizing = false;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const workLimit = MAX_D1_QUERIES_PER_INVOCATION - FINALIZATION_D1_QUERY_RESERVE;
  const count = () => {
    const invocationLimit = finalizing ? MAX_D1_QUERIES_PER_INVOCATION : workLimit;
    if (queryCount + outboundCount >= invocationLimit) {
      throw new Error("D1 invocation query_limit exceeded");
    }
    queryCount += 1;
  };
  const beforeFetch = () => {
    const invocationLimit = finalizing ? MAX_D1_QUERIES_PER_INVOCATION : workLimit;
    if (queryCount + outboundCount >= invocationLimit) {
      throw new Error("Worker invocation subrequest_limit exceeded");
    }
    outboundCount += 1;
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (["run", "first", "all", "raw"].includes(String(property))) {
          const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            count();
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count();
          return target.batch(statements.map((statement) => originals.get(statement as object) ?? statement));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return {
    db: wrappedDb,
    count: () => queryCount,
    beforeFetch,
    beginFinalization: () => { finalizing = true; },
  };
}

function scheduleResult(): ScheduleResult {
  return {
    status: "succeeded",
    sourcesProcessed: 0,
    sourceFetches: 0,
    articleFetches: 0,
    sitemapFetches: 0,
    discovered: 0,
    stored: 0,
    d1Queries: 0,
    errorCode: null,
    httpStatus: null,
  };
}

function boundedConditionalHeader(value: string | null): string | null {
  if (value === null || new TextEncoder().encode(value).byteLength > MAX_CONDITIONAL_HEADER_BYTES) return null;
  return value;
}

function retryAfterSeconds(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d+$/u.test(value.trim())) {
    const seconds = Number(value.trim());
    return Number.isSafeInteger(seconds) ? now + seconds : null;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(now + 1, Math.floor(date / 1000));
}

function retryBackoff(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 12);
  const base = Math.min(30 * (2 ** exponent), MAX_BACKOFF_SECONDS);
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

function getFailure(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("subrequest_limit")) {
    return { code: "subrequest_limit", message: "Worker subrequest budget reached" };
  }
  if (/private|localhost|userinfo|public URL|host/i.test(text)) {
    return { code: "blocked_unsafe_url", message: "URL rejected by the public-fetch policy" };
  }
  return { code: "fetch_error", message: "The upstream request failed" };
}

function sourceCandidate(source: Source): Candidate {
  return {
    sourceId: source.id,
    dedupeKey: source.url,
    canonicalUrl: source.url,
    externalId: null,
    title: null,
    summary: null,
    author: null,
    publishedAt: null,
    sourceCursor: null,
  };
}

function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function terminalHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

async function recordSourceStatus(
  db: D1Database,
  sourceId: string,
  now: number,
  status: string,
  success: boolean,
  nextFetchAt: number,
  updateSchedule = true,
): Promise<boolean> {
  const reservation = await checkWriteGate(db, "source", SOURCE_WRITE_RESERVATION_BYTES, crypto.randomUUID(), now);
  if (reservation === "storage_limit") return false;
  let sizeAfter = reservation.measuredSize;
  try {
    const update = await db.prepare(`
      UPDATE sources
      SET last_status = ?, last_fetched_at = ?,
          next_fetch_at = CASE WHEN ? = 1 THEN ? ELSE next_fetch_at END,
          consecutive_errors = CASE WHEN ? = 1 THEN 0 ELSE consecutive_errors + 1 END,
          updated_at = ?
      WHERE id = ?
    `).bind(status, now, Number(updateSchedule), nextFetchAt, Number(success), now, sourceId).run();
    sizeAfter = update.meta.size_after;
    return sizeAfter < D1_STORAGE_STOP_BYTES;
  } finally {
    await completeWriteReservation(db, reservation.id, sizeAfter, now);
  }
}

async function recordSourceSuccess(
  db: D1Database,
  source: Source,
  now: number,
  etag: string | null,
  lastModified: string | null,
  status: string,
): Promise<boolean> {
  const reservation = await checkWriteGate(db, "source", SOURCE_WRITE_RESERVATION_BYTES, crypto.randomUUID(), now);
  if (reservation === "storage_limit") return false;
  let sizeAfter = reservation.measuredSize;
  try {
    const update = await db.prepare(`
      UPDATE sources
      SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
          last_status = ?, last_fetched_at = ?, next_fetch_at = ?, consecutive_errors = 0,
          updated_at = ?
      WHERE id = ?
    `).bind(
      etag, lastModified, status, now, now + source.poll_interval_sec, now, source.id,
    ).run();
    sizeAfter = update.meta.size_after;
    return sizeAfter < D1_STORAGE_STOP_BYTES;
  } finally {
    await completeWriteReservation(db, reservation.id, sizeAfter, now);
  }
}

async function saveRunResult(
  db: D1Database,
  runId: string,
  sourceId: string | null,
  result: ScheduleResult,
  startedAt: number,
  finishedAt: number,
  errorMessage: string | null,
): Promise<void> {
  await db.prepare(`
    UPDATE fetch_runs
    SET source_id = COALESCE(?, source_id), finished_at = ?, status = ?, http_status = ?,
        discovered_count = ?, stored_count = ?, error_code = ?, error_message = ?
    WHERE id = ? AND started_at = ?
  `).bind(
    sourceId, finishedAt, result.status, result.httpStatus, result.discovered, result.stored,
    result.errorCode, errorMessage, runId, startedAt,
  ).run();
}

async function purgeExpiredFetchRuns(db: D1Database, now: number): Promise<void> {
  await db.prepare(`
    DELETE FROM fetch_runs
    WHERE status <> 'running'
      AND COALESCE(finished_at, started_at) <= ?
  `).bind(now - 30 * 24 * 60 * 60).run();
}

async function sourceForPending(db: D1Database, item: PendingItem): Promise<Source | null> {
  return await getSource(db, item.source_id);
}

async function handleArticlePending(
  db: D1Database,
  source: Source,
  item: PendingItem,
  now: number,
  onRequest: () => void,
): Promise<{ status: "stored" | "partial" | "blocked" | "storage_limit"; errorCode: string | null; httpStatus: number | null; committed?: boolean }> {
  let response;
  try {
    response = await fetchPendingDocument(source, item, onRequest);
  } catch (error) {
    const failure = getFailure(error);
    if (failure.code === "blocked_unsafe_url") {
      await markPendingFailure(db, item, { kind: "terminal", status: "blocked", now, ...failure });
      return { status: "blocked", errorCode: failure.code, httpStatus: null };
    }
    await markPendingFailure(db, item, {
      kind: "retryable", nextAttemptAt: now + retryBackoff(item.attempts + 1), ...failure,
    });
    return { status: "partial", errorCode: failure.code, httpStatus: null };
  }

  if (response.status < 200 || response.status >= 300) {
    const code = `http_${response.status}`;
    const retryAt = response.status === 429 ? retryAfterSeconds(response.headers.get("Retry-After"), now) : null;
    if (terminalHttpStatus(response.status)) {
      await markPendingFailure(db, item, {
        kind: "terminal", status: "blocked", now, code, message: `Upstream returned HTTP ${response.status}`,
      });
    } else {
      await markPendingFailure(db, item, {
        kind: "retryable",
        nextAttemptAt: retryAt ?? now + retryBackoff(item.attempts + 1),
        code,
        message: `Upstream returned HTTP ${response.status}`,
      });
    }
    return { status: terminalHttpStatus(response.status) ? "blocked" : "partial", errorCode: code, httpStatus: response.status };
  }

  if (item.item_type === "sitemap") {
    const discovery = await discoverSource(db, source, response.body, response.headers.get("Content-Type") ?? "application/xml", {
      now,
      maxCandidates: DISCOVERY_NEW_CANDIDATE_LIMIT,
      maxChecks: DISCOVERY_CHECK_LIMIT,
      pendingSitemapId: item.id,
      pendingSitemapLeaseToken: item.lease_token ?? undefined,
      pendingSitemapCursor: item.sitemap_cursor,
    });
    if (discovery.stopReason === "storage_limit") return { status: "storage_limit", errorCode: "storage_limit", httpStatus: response.status };
    if (discovery.stopReason !== null && discovery.stopReason !== "max_candidates" && discovery.stopReason !== "query_limit") {
      await markPendingFailure(db, item, {
        kind: "retryable", nextAttemptAt: now + retryBackoff(item.attempts + 1),
        code: discovery.stopReason, message: "Sitemap discovery could not be fully accounted",
      });
      return { status: "partial", errorCode: discovery.stopReason, httpStatus: response.status };
    }
    if (discovery.hasMore) {
      await markPendingFailure(db, item, {
        kind: "retryable", nextAttemptAt: now + source.poll_interval_sec,
        code: "sitemap_page_remaining", message: "More sitemap entries remain for a later page",
      });
      return { status: "partial", errorCode: "sitemap_page_remaining", httpStatus: response.status };
    }
    const completed = await db.prepare(`
      DELETE FROM pending_items
      WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
    `).bind(item.id, item.lease_token, now).run();
    if (completed.meta.changes === 0) return { status: "partial", errorCode: "lease_lost", httpStatus: response.status };
    return { status: "stored", errorCode: null, httpStatus: response.status, committed: true };
  }

  const selectors = source.selectors ?? (source.kind === "feed" || source.kind === "sitemap"
    ? { title: "h1", summary: "meta[name='description']", author: "meta[name='author']", publishedAt: "time[datetime]", body: "article" }
    : null);
  if (selectors === null) {
    await markPendingFailure(db, item, {
      kind: "terminal", status: "blocked", now, code: "unsupported_source", message: "Article selectors are unavailable",
    });
    return { status: "blocked", errorCode: "unsupported_source", httpStatus: response.status };
  }
  let article;
  try {
    article = await extractArticle(response.body, selectors);
  } catch {
    await markPendingFailure(db, item, {
      kind: "terminal", status: "failed", now, code: "parse_error", message: "Article content could not be parsed",
    });
    return { status: "partial", errorCode: "parse_error", httpStatus: response.status };
  }
  if (article.title === null || article.body.trim().length === 0) {
    await markPendingFailure(db, item, {
      kind: "terminal", status: "blocked", now, code: "unsupported_dynamic_page", message: "Configured article selectors returned no usable content",
    });
    return { status: "blocked", errorCode: "unsupported_dynamic_page", httpStatus: response.status };
  }
  const saved = await saveArticleAndCompletePending(db, item, {
    title: article.title,
    summary: article.summary,
    author: article.author,
    publishedAt: article.publishedAt,
    contentText: article.body,
  });
  if (saved.status === "storage_limit") {
    return { status: "storage_limit", errorCode: "storage_limit", httpStatus: response.status, committed: saved.committed === true };
  }
  if (saved.status === "lease_lost") return { status: "partial", errorCode: "lease_lost", httpStatus: response.status };
  if (saved.status === "metadata_too_large" || saved.status === "row_too_large") {
    await markPendingFailure(db, item, {
      kind: "terminal", status: "failed", now, code: saved.status, message: "Article metadata exceeds the storage limits",
    });
    return { status: "partial", errorCode: saved.status, httpStatus: response.status };
  }
  return {
    status: saved.status === "content_too_large" ? "partial" : "stored",
    errorCode: saved.status === "content_too_large" ? "content_too_large" : null,
    httpStatus: response.status,
    committed: true,
  };
}

async function handleSourceFetch(
  db: D1Database,
  source: Source,
  now: number,
  result: ScheduleResult,
  onRequest: () => void,
): Promise<{ sourceId: string; errorMessage: string | null; httpStatus: number | null; sourceFetchKind: "feed" | "sitemap" | "none" }> {
  result.sourcesProcessed += 1;
  const recordFailure = async (status: string, nextFetchAt: number) => {
    const recorded = await recordSourceStatus(db, source.id, now, status, false, nextFetchAt);
    if (!recorded) {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
    }
  };
  if (source.kind === "article") {
    const enqueued = await enqueueCandidates(db, source, [sourceCandidate(source)], {
      now,
      maxCandidates: 1,
      maxChecks: 1,
    });
    result.discovered += enqueued.inserted;
    if (enqueued.stopReason === "storage_limit") {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
      return { sourceId: source.id, errorMessage: "D1 storage limit reached while queueing a direct source", httpStatus: null, sourceFetchKind: "none" };
    }
    if (enqueued.stopReason !== null) {
      result.status = "partial";
      result.errorCode = enqueued.stopReason;
    }
    const sourceRecorded = await recordSourceSuccess(
      db,
      source,
      now,
      null,
      null,
      "queued",
    );
    if (!sourceRecorded) {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
    }
    return { sourceId: source.id, errorMessage: null, httpStatus: null, sourceFetchKind: "none" };
  }

  result.sourceFetches += 1;
  let response;
  try {
    response = await fetchSourceDocument(source, onRequest);
  } catch (error) {
    const failure = getFailure(error);
    result.status = failure.code === "blocked_unsafe_url" ? "blocked" : "failed";
    result.errorCode = failure.code;
    await recordFailure(failure.code, now + retryBackoff(source.consecutive_errors + 1));
    return { sourceId: source.id, errorMessage: failure.message, httpStatus: null, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
  }

  if (response.status === 304) {
    result.httpStatus = response.status;
    const recorded = await recordSourceSuccess(db, source, now,
      boundedConditionalHeader(response.headers.get("ETag")),
      boundedConditionalHeader(response.headers.get("Last-Modified")),
      "not_modified");
    if (!recorded) {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
    }
    return { sourceId: source.id, errorMessage: null, httpStatus: 304, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
  }
  if (!isSuccessfulHttpStatus(response.status)) {
    const code = `http_${response.status}`;
    result.httpStatus = response.status;
    const retryAt = response.status === 429 ? retryAfterSeconds(response.headers.get("Retry-After"), now) : null;
    result.status = terminalHttpStatus(response.status) ? "blocked" : "failed";
    result.errorCode = code;
    const message = `Upstream returned HTTP ${response.status}`;
    await recordFailure(code, retryAt ?? now + retryBackoff(source.consecutive_errors + 1));
    return { sourceId: source.id, errorMessage: message, httpStatus: response.status, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
  }

  try {
    result.httpStatus = response.status;
    const discoveryBudget = {
      now,
      maxCandidates: DISCOVERY_NEW_CANDIDATE_LIMIT,
      maxChecks: DISCOVERY_CHECK_LIMIT,
    };
    const discovered = source.kind === "html_list"
      ? await discoverHtmlList(db, source, response.body, discoveryBudget, response.url.href)
      : await discoverSource(db, source, response.body, response.headers.get("Content-Type") ?? "application/octet-stream", discoveryBudget);
    result.discovered += discovered.inserted;
    if (discovered.stopReason === "storage_limit") {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
    } else if (discovered.stopReason !== null || discovered.hasMore) {
      result.status = result.status === "succeeded" ? "partial" : result.status;
      result.errorCode ??= discovered.stopReason;
    }
    if (result.status === "storage_limit") {
      return { sourceId: source.id, errorMessage: "D1 storage limit reached during source discovery", httpStatus: response.status, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
    }
    const recorded = await recordSourceSuccess(db, source, now,
      boundedConditionalHeader(response.headers.get("ETag")),
      boundedConditionalHeader(response.headers.get("Last-Modified")),
      discovered.blocked > 0 ? "blocked" : "ok");
    if (!recorded) {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
    }
    return { sourceId: source.id, errorMessage: null, httpStatus: response.status, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
  } catch {
    result.status = "failed";
    result.errorCode = "parse_error";
    const message = "Source document could not be parsed";
    await recordFailure("parse_error", now + retryBackoff(source.consecutive_errors + 1));
    return { sourceId: source.id, errorMessage: message, httpStatus: response.status, sourceFetchKind: source.kind === "sitemap" ? "sitemap" : "feed" };
  }
}

async function processPendingItem(
  db: D1Database,
  item: PendingItem,
  now: number,
  result: ScheduleResult,
  onRequest: () => void,
): Promise<{ sourceId: string | null; errorMessage: string | null }> {
  const source = await sourceForPending(db, item);
  if (source === null) {
    await markPendingFailure(db, item, {
      kind: "terminal", status: "failed", now, code: "source_missing", message: "Owning source no longer exists",
    });
    result.status = "partial";
    result.errorCode ??= "source_missing";
    return { sourceId: item.source_id, errorMessage: "Owning source no longer exists" };
  }

  const outcome = await handleArticlePending(db, source, item, now, onRequest);
  if (outcome.httpStatus !== null) result.httpStatus = outcome.httpStatus;
  if (outcome.committed === true && item.item_type === "article") result.stored += 1;
  if (outcome.status === "storage_limit") {
    result.status = "storage_limit";
    result.errorCode = "storage_limit";
    return { sourceId: source.id, errorMessage: "D1 storage limit reached while processing a pending item" };
  }
  if (outcome.status === "blocked") {
    if (result.status === "succeeded") result.status = "blocked";
    result.errorCode ??= outcome.errorCode;
  } else if (outcome.status === "partial") {
    if (result.status === "succeeded") result.status = "partial";
    result.errorCode ??= outcome.errorCode;
  }

  if (outcome.errorCode !== null) {
    const sourceWritten = await recordSourceStatus(
      db,
      source.id,
      now,
      outcome.errorCode,
      false,
      now + retryBackoff(source.consecutive_errors + 1),
      false,
    );
    if (!sourceWritten) {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
      return { sourceId: source.id, errorMessage: "D1 storage limit reached while recording source status" };
    }
  }

  return {
    sourceId: source.id,
    errorMessage: outcome.errorCode === null ? null : `Pending item failed with ${outcome.errorCode}`,
  };
}

export async function runScheduled(env: Env, scheduledTime: number): Promise<ScheduleResult> {
  const budget = withQueryBudget(env.DB);
  const db = budget.db;
  const scheduledAt = Math.floor(scheduledTime / 1000);
  const now = Math.floor(Date.now() / 1000);
  const result = scheduleResult();
  const runId = crypto.randomUUID();
  let runReservation: WriteReservation | null = null;
  let leaseToken: string | null = null;
  let leaseOwned = false;
  let runStarted = false;
  let sourceIdForRun: string | null = null;
  let runErrorMessage: string | null = null;

  try {
    const state = await db.prepare(`
      SELECT export_lock, export_lock_expires_at
      FROM system_state WHERE singleton_id = 'global'
    `).first<{ export_lock: number; export_lock_expires_at: number | null }>();
    if (state?.export_lock === 1 && (state.export_lock_expires_at ?? 0) > now) {
      result.status = "export_locked";
      return result;
    }

    const reservation = await checkWriteGate(db, "run", RUN_WRITE_RESERVATION_BYTES, runId, now);
    if (reservation === "storage_limit") {
      result.status = "storage_limit";
      result.errorCode = "storage_limit";
      return result;
    }
    runReservation = reservation;

    leaseToken = crypto.randomUUID();
    const acquired = await db.prepare(`
      UPDATE system_state
      SET global_lease_token = ?, global_lease_expires_at = ?, updated_at = ?,
          export_lock = 0, export_lock_id = NULL, export_lock_expires_at = NULL
      WHERE singleton_id = 'global'
        AND (export_lock = 0 OR export_lock_expires_at <= ?)
        AND (global_lease_token IS NULL OR global_lease_expires_at <= ?)
      RETURNING global_lease_token
    `).bind(leaseToken, now + GLOBAL_LEASE_SECONDS, now, now, now).first<{ global_lease_token: string }>();
    if (acquired?.global_lease_token !== leaseToken) {
      result.status = "lease_busy";
      return result;
    }
    leaseOwned = true;

    await purgeExpiredTerminalItems(db, now);
    await purgeExpiredFetchRuns(db, now);

    await db.prepare(`
      INSERT INTO fetch_runs (id, started_at, status)
      VALUES (?, ?, 'running')
    `).bind(runId, scheduledAt).run();
    runStarted = true;

    const eligible = await db.prepare(`
      SELECT
        SUM(CASE WHEN item_type = 'sitemap' THEN 1 ELSE 0 END) AS sitemap_count,
        COUNT(*) AS pending_count
      FROM pending_items
      WHERE (status IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at <= ?)
    `).bind(now, now).first<{ sitemap_count: number | null; pending_count: number }>();
    const pendingCount = eligible?.pending_count ?? 0;
    let dueSource: Source | null = null;
    const drainArticles = async (limit: number) => {
      const target = Math.min(ARTICLE_FETCH_LIMIT, result.articleFetches + limit);
      while (result.articleFetches < target) {
        const item = await claimPending(db, now, crypto.randomUUID(), "article");
        if (item === null) break;
        result.articleFetches += 1;
        const outcome = await processPendingItem(db, item, now, result, budget.beforeFetch);
        sourceIdForRun ??= outcome.sourceId;
        runErrorMessage ??= outcome.errorMessage;
        if (result.status === "storage_limit" || result.errorCode === "subrequest_limit") break;
      }
    };

    if ((eligible?.sitemap_count ?? 0) > 0) {
      const sitemap = await claimPending(db, now, crypto.randomUUID(), "sitemap");
      if (sitemap !== null) {
        result.sitemapFetches = 1;
        const outcome = await processPendingItem(db, sitemap, now, result, budget.beforeFetch);
        sourceIdForRun ??= outcome.sourceId;
        runErrorMessage ??= outcome.errorMessage;
      }
      if (result.errorCode !== "storage_limit") {
        await drainArticles(ARTICLE_FETCH_LIMIT);
      }
    } else {
      const initialPendingDrain = Math.min(pendingCount, ARTICLE_FETCH_LIMIT);
      await drainArticles(initialPendingDrain);
      if (pendingCount >= BACKLOG_SOURCE_DEFERRAL_COUNT) {
        if (result.status === "succeeded") result.status = "partial";
        result.errorCode ??= "backlog_priority";
        runErrorMessage ??= "Due source polling deferred while the pending backlog is large";
      } else if (result.status !== "storage_limit" && result.errorCode !== "subrequest_limit") {
        const due = await db.prepare(`
          SELECT id FROM sources
          WHERE enabled = 1 AND next_fetch_at <= ?
          ORDER BY next_fetch_at ASC, id ASC
          LIMIT 1
        `).bind(now).first<{ id: string }>();
        if (due) dueSource = await getSource(db, due.id);
        if (dueSource !== null) {
          sourceIdForRun = dueSource.id;
          const sourceResult = await handleSourceFetch(db, dueSource, now, result, budget.beforeFetch);
          runErrorMessage ??= sourceResult.errorMessage;
          if (sourceResult.sourceFetchKind === "sitemap") result.sitemapFetches += 1;
        }
        if (result.errorCode !== "storage_limit" && result.errorCode !== "subrequest_limit") {
          await drainArticles(ARTICLE_FETCH_LIMIT - result.articleFetches);
        }
      }
    }

    const remainingPending = await db.prepare(`
      SELECT COUNT(*) AS count FROM pending_items
      WHERE status IN ('pending', 'leased', 'retry_wait')
    `).first<{ count: number }>();
    if ((remainingPending?.count ?? 0) > 0 && result.status === "succeeded") {
      result.status = "partial";
      result.errorCode ??= "pending_backlog";
      runErrorMessage ??= "Durable pending items remain for a later scheduled run";
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "";
    const storageStopped = messageText.includes("storage_limit");
    const queryStopped = messageText.includes("query_limit");
    const requestStopped = messageText.includes("subrequest_limit");
    const message = storageStopped
      ? "Ingestion stopped because the D1 storage gate is closed"
      : queryStopped
        ? "D1 query budget reached"
        : requestStopped
          ? "Worker subrequest budget reached"
          : "Scheduled ingestion failed";
    result.status = storageStopped ? "storage_limit" : "failed";
    result.errorCode = storageStopped ? "storage_limit" : queryStopped ? "query_limit" : requestStopped ? "subrequest_limit" : "run_error";
    runErrorMessage ??= message;
  } finally {
    budget.beginFinalization();
    try {
      const storage = await db.prepare(`
        SELECT observed_db_size, storage_state
        FROM system_state WHERE singleton_id = 'global'
      `).first<{ observed_db_size: number; storage_state: string }>();
      if (storage?.storage_state !== "normal" || (storage?.observed_db_size ?? 0) >= D1_STORAGE_STOP_BYTES) {
        result.status = "storage_limit";
        result.errorCode = "storage_limit";
        runErrorMessage ??= "Ingestion stopped at the D1 storage threshold";
      }
    } catch {
      // If D1 is unavailable, the run record and reservation expiry are best-effort.
    }
    if (runStarted) {
      try {
        await saveRunResult(db, runId, sourceIdForRun, result, scheduledAt, Math.floor(Date.now() / 1000), runErrorMessage);
      } catch {
        result.status = result.status === "storage_limit" ? "storage_limit" : "failed";
        result.errorCode ??= "run_log_error";
      }
    }
    if (leaseOwned && leaseToken !== null) {
      try {
        await db.prepare(`
          UPDATE system_state
          SET global_lease_token = NULL, global_lease_expires_at = NULL, updated_at = ?
          WHERE singleton_id = 'global' AND global_lease_token = ?
        `).bind(Math.floor(Date.now() / 1000), leaseToken).run();
      } catch {
        // The bounded lease expiry permits recovery if D1 is temporarily unavailable.
      }
    }
    if (runReservation !== null) {
      try {
        const size = await db.prepare("SELECT 1 AS scheduled_size_probe").run();
        await completeWriteReservation(db, runReservation.id, size.meta.size_after, Math.floor(Date.now() / 1000));
      } catch {
        // The reservation expires after 120 seconds if a final D1 observation cannot be written.
      }
    }
    result.d1Queries = budget.count();
  }

  return result;
}
