import { normalizePublishedAt } from "./feed-parser";
import { checkWriteGate, completeWriteReservation, D1_STORAGE_STOP_BYTES } from "./storage-guard";
import type { PendingItem } from "./pending-repository";
import type { ArticleInput, SaveArticleResult } from "../articles/types";

const MAX_EXTERNAL_ID_BYTES = 1_024;
const MAX_URL_BYTES = 4_096;
const MAX_TITLE_BYTES = 4_096;
const MAX_SUMMARY_BYTES = 16 * 1_024;
const MAX_AUTHOR_BYTES = 1_024;
const MAX_PUBLISHED_AT_BYTES = 64;
const MAX_CONTENT_BYTES = 512_000;
const MAX_ARTICLE_ROW_BYTES = 1_800_000;
const ESTIMATED_ARTICLE_GROWTH_BYTES = 640 * 1024;

function utf8Bytes(value: string | null): number {
  return value === null ? 0 : new TextEncoder().encode(value).byteLength;
}

function contentHash(content: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

async function boundedArticleId(item: PendingItem): Promise<string> {
  const identity = item.external_id === null ? item.canonical_url : `external:${item.external_id}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${item.source_id}\u0000${identity}`),
  );
  return `article_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function saveArticleAndCompletePending(
  db: D1Database,
  item: PendingItem,
  input: ArticleInput,
): Promise<SaveArticleResult> {
  const now = Math.floor(Date.now() / 1000);
  const title = input.title.trim() || item.title || item.canonical_url;
  const summary = input.summary === null || input.summary.trim().length === 0 ? item.summary : input.summary.trim();
  const author = input.author === null || input.author.trim().length === 0 ? null : input.author.trim();
  const publishedAt = normalizePublishedAt(input.publishedAt ?? item.published_at);
  const tooLarge = utf8Bytes(item.external_id) > MAX_EXTERNAL_ID_BYTES
    || utf8Bytes(item.canonical_url) > MAX_URL_BYTES
    || utf8Bytes(title) > MAX_TITLE_BYTES
    || utf8Bytes(summary) > MAX_SUMMARY_BYTES
    || utf8Bytes(author) > MAX_AUTHOR_BYTES
    || utf8Bytes(publishedAt) > MAX_PUBLISHED_AT_BYTES;
  if (tooLarge) return { status: "metadata_too_large", articleId: null };

  const originalContentBytes = utf8Bytes(input.contentText);
  const tooLargeContent = originalContentBytes > MAX_CONTENT_BYTES;
  const contentText = tooLargeContent ? "" : input.contentText;
  const rowBytes = utf8Bytes(item.source_id)
    + utf8Bytes(item.external_id)
    + utf8Bytes(item.canonical_url)
    + utf8Bytes(title)
    + utf8Bytes(summary)
    + utf8Bytes(author)
    + utf8Bytes(publishedAt)
    + utf8Bytes(contentText)
    + 512;
  if (rowBytes > MAX_ARTICLE_ROW_BYTES) return { status: "row_too_large", articleId: null };

  const articleId = await boundedArticleId(item);
  const hash = await contentHash(input.contentText);
  const reservation = await checkWriteGate(db, "article", ESTIMATED_ARTICLE_GROWTH_BYTES);
  if (reservation === "storage_limit") return { status: "storage_limit", articleId: null };

  let latestSize = reservation.measuredSize;
  try {
    const result = await db.batch([
      db.prepare(`
        DELETE FROM articles_fts
        WHERE article_id IN (
          SELECT id FROM articles
          WHERE source_id = ? AND ((? IS NOT NULL AND external_id = ?) OR canonical_url = ?)
        )
          AND EXISTS (
            SELECT 1 FROM pending_items
            WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
          )
      `).bind(item.source_id, item.external_id, item.external_id, item.canonical_url, item.id, item.lease_token, now),
      db.prepare(`
        INSERT INTO articles (
          id, source_id, external_id, canonical_url, title, summary, author,
          published_at, fetched_at, content_text, content_hash, status, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM pending_items
          WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
        )
        ON CONFLICT DO UPDATE SET
          external_id = excluded.external_id,
          canonical_url = excluded.canonical_url,
          title = excluded.title,
          summary = excluded.summary,
          author = excluded.author,
          published_at = excluded.published_at,
          fetched_at = excluded.fetched_at,
          content_text = excluded.content_text,
          content_hash = excluded.content_hash,
          status = excluded.status,
          updated_at = excluded.updated_at
        RETURNING id
      `).bind(
        articleId, item.source_id, item.external_id, item.canonical_url, title,
        summary, author, publishedAt, now, contentText, hash,
        tooLargeContent ? "content_too_large" : "stored", now,
        item.id, item.lease_token, now,
      ),
      db.prepare(`
        INSERT INTO articles_fts (article_id, title, snippet)
        SELECT article.id, article.title, COALESCE(article.summary, '')
        FROM articles AS article
        WHERE article.source_id = ?
          AND ((? IS NOT NULL AND article.external_id = ?) OR article.canonical_url = ?)
          AND EXISTS (
            SELECT 1 FROM pending_items
            WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
          )
        ORDER BY CASE WHEN ? IS NOT NULL AND article.external_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).bind(
        item.source_id, item.external_id, item.external_id, item.canonical_url,
        item.id, item.lease_token, now, item.external_id, item.external_id,
      ),
      db.prepare(`
        DELETE FROM pending_items
        WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?
      `).bind(item.id, item.lease_token, now),
    ]);
    latestSize = result.reduce(
      (largest, statementResult) => Math.max(largest, statementResult.meta.size_after ?? reservation.measuredSize),
      reservation.measuredSize,
    );
    const savedId = (result[1] as D1Result<{ id: string }> | undefined)?.results?.[0]?.id;
    if (savedId === undefined || (result[3]?.meta.changes ?? 0) === 0) {
      return { status: "lease_lost", articleId: null };
    }
    if (latestSize >= D1_STORAGE_STOP_BYTES) {
      return { status: "storage_limit", articleId: null, committed: true };
    }
    return tooLargeContent
      ? { status: "content_too_large", articleId: savedId, committed: true }
      : { status: "saved", articleId: savedId, committed: true };
  } finally {
    await completeWriteReservation(db, reservation.id, latestSize, now);
  }
}
