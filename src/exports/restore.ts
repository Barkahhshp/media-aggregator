import type { ExportCounts, ExportManifest, ExportRecord } from "./repository.ts";
import { EXPORT_SCHEMA_VERSION } from "./repository.ts";

export interface RestorableArticle extends Record<string, unknown> {
  id: string;
  source_id: string;
  content_hash: string;
  content_text: string;
}

export interface ParsedExport {
  manifest: ExportManifest;
  sources: Array<Record<string, unknown>>;
  pending_items: Array<Record<string, unknown>>;
  articles: RestorableArticle[];
}

export interface RestoreResult {
  counts: ExportCounts;
  verified_article_hashes: number;
}

const SOURCE_COLUMNS = [
  "id", "url", "kind", "host", "poll_interval_sec", "selectors_json", "enabled", "next_fetch_at",
  "etag", "last_modified", "feed_watermark", "sitemap_last_loc", "consecutive_errors", "last_status",
  "last_fetched_at", "created_at", "updated_at",
] as const;
const PENDING_COLUMNS = [
  "id", "source_id", "item_type", "dedupe_key", "external_id", "canonical_url", "title", "summary",
  "published_at", "status", "attempts", "next_attempt_at", "lease_token", "lease_expires_at",
  "sitemap_cursor", "last_error", "terminal_expires_at", "discovered_at", "created_at", "updated_at",
] as const;
const ARTICLE_COLUMNS = [
  "id", "source_id", "external_id", "canonical_url", "title", "summary", "author", "published_at",
  "fetched_at", "content_text", "content_hash", "status", "created_at", "updated_at",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid export ${label}`);
  }
  return value;
}

function assertCounts(value: unknown): ExportCounts {
  if (!isObject(value)) throw new Error("Invalid export counts");
  const sources = value.sources;
  const pendingItems = value.pending_items;
  const articles = value.articles;
  if (![sources, pendingItems, articles].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) {
    throw new Error("Invalid export counts");
  }
  return {
    sources: Number(sources),
    pending_items: Number(pendingItems),
    articles: Number(articles),
  };
}

function decodeFullText(encoded: unknown): string {
  if (typeof encoded !== "string" || encoded.length > 700_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error("Invalid article full-text encoding");
  }
  let text: string;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid article full-text encoding");
  }
  if (new TextEncoder().encode(text).byteLength > 512_000) {
    throw new Error("Article full text exceeds the schema limit");
  }
  return text;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function parseExportNdjson(ndjson: string): Promise<ParsedExport> {
  if (ndjson.length === 0 || ndjson.length > 1_500_000_000) throw new Error("Export file is empty or too large");
  const lines = ndjson.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Export file contains no NDJSON records");

  let manifest: ExportManifest | null = null;
  const sources: Array<Record<string, unknown>> = [];
  const pendingItems: Array<Record<string, unknown>> = [];
  const articles: RestorableArticle[] = [];
  const seenIds = {
    source: new Set<string>(),
    pending: new Set<string>(),
    article: new Set<string>(),
  };

  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid NDJSON at line ${index + 1}`);
    }
    if (!isObject(value)) throw new Error(`Invalid NDJSON record at line ${index + 1}`);
    if (value.type === "manifest") {
      const schemaVersion = value.schema_version;
      const snapshotId = assertString(value.snapshot_id, "snapshot id", 128);
      const watermark = assertString(value.export_watermark, "export watermark", 128);
      const exportedAt = value.exported_at;
      const counts = assertCounts(value.counts);
      if (schemaVersion !== EXPORT_SCHEMA_VERSION || !Number.isSafeInteger(exportedAt) || value.full_text_encoding !== "base64-utf8") {
        throw new Error("Unsupported or invalid export manifest");
      }
      const current: ExportManifest = {
        type: "manifest",
        schema_version: schemaVersion,
        snapshot_id: snapshotId,
        export_watermark: watermark,
        exported_at: Number(exportedAt),
        counts,
        full_text_encoding: "base64-utf8",
        next_cursor: typeof value.next_cursor === "string" ? value.next_cursor : null,
      };
      if (value.next_cursor !== null && typeof value.next_cursor !== "string") {
        throw new Error("Invalid export cursor in manifest");
      }
      if (manifest === null) manifest = current;
      else if (
        current.schema_version !== manifest.schema_version ||
        current.snapshot_id !== manifest.snapshot_id ||
        current.export_watermark !== manifest.export_watermark ||
        JSON.stringify(current.counts) !== JSON.stringify(manifest.counts) ||
        current.full_text_encoding !== manifest.full_text_encoding
      ) {
        throw new Error("The export contains inconsistent page manifests");
      }
      continue;
    }

    const recordType = value.type;
    const row = value.record;
    if (!isObject(row)) throw new Error(`Invalid export record at line ${index + 1}`);
    if (recordType !== "source" && recordType !== "pending" && recordType !== "article") {
      throw new Error(`Unknown export record type at line ${index + 1}`);
    }
    const id = assertString(row.id, `${recordType} id`, 128);
    const seen = seenIds[recordType];
    if (seen.has(id)) throw new Error(`Duplicate ${recordType} id in export: ${id}`);
    seen.add(id);

    if (recordType === "source") {
      sources.push(row);
      continue;
    }
    if (recordType === "pending") {
      pendingItems.push(row);
      continue;
    }
    const sourceId = assertString(row.source_id, "article source id", 128);
    const contentHash = assertString(row.content_hash, "article content hash", 128);
    const contentText = decodeFullText(row.content_text_base64);
    const contentWasOmittedAsTooLarge = row.status === "content_too_large"
      && contentText === ""
      && /^[a-f0-9]{64}$/iu.test(contentHash);
    if (await sha256Hex(contentText) !== contentHash && !contentWasOmittedAsTooLarge) {
      throw new Error(`Article content hash mismatch for ${id}`);
    }
    const { content_text_base64: _contentTextBase64, ...metadata } = row;
    articles.push({ ...metadata, id, source_id: sourceId, content_hash: contentHash, content_text: contentText });
  }

  if (manifest === null) throw new Error("Export manifest is missing");
  if (
    manifest.counts.sources !== sources.length ||
    manifest.counts.pending_items !== pendingItems.length ||
    manifest.counts.articles !== articles.length
  ) {
    throw new Error("Export row counts do not match the manifest");
  }
  return { manifest, sources, pending_items: pendingItems, articles };
}

function getRowValues(row: Record<string, unknown>, columns: readonly string[]): (string | number | null)[] {
  return columns.map((column) => {
    const value = row[column];
    if (value === null || typeof value === "string" || typeof value === "number") return value;
    throw new Error(`Export row is missing a valid ${column} value`);
  });
}

function insertStatement(db: D1Database, table: string, columns: readonly string[], row: Record<string, unknown>) {
  const placeholders = columns.map(() => "?").join(", ");
  return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
    .bind(...getRowValues(row, columns));
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) output.push(items.slice(offset, offset + size));
  return output;
}

async function assertEmptyTarget(db: D1Database): Promise<void> {
  const counts = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sources) AS sources,
      (SELECT COUNT(*) FROM pending_items) AS pending_items,
      (SELECT COUNT(*) FROM articles) AS articles,
      (SELECT COUNT(*) FROM articles_fts) AS articles_fts,
      (SELECT COUNT(*) FROM export_sessions) AS export_sessions,
      (SELECT COUNT(*) FROM storage_write_reservations) AS reservations,
      (SELECT COUNT(*) FROM fetch_runs) AS fetch_runs
  `).first<Record<string, number>>();
  if (!counts || Object.values(counts).some((count) => Number(count) !== 0)) {
    throw new Error("Restore target must be an empty D1 database; clear or recreate local D1 and rerun");
  }
}

async function verifyRestoredArticles(db: D1Database, expected: Map<string, string>): Promise<number> {
  let cursor = "";
  let verified = 0;
  while (true) {
    const rows = await db.prepare(`
      SELECT id, content_text, content_hash, status
      FROM articles WHERE id > ? ORDER BY id LIMIT 10
    `).bind(cursor).all<{ id: string; content_text: string; content_hash: string; status: string }>();
    const batchRows = rows.results ?? [];
    for (const row of batchRows) {
      const originalHash = expected.get(row.id);
      const computedHash = await sha256Hex(row.content_text);
      const omittedTooLargeText = row.status === "content_too_large" && row.content_text === ""
        && /^[a-f0-9]{64}$/iu.test(row.content_hash);
      if (!originalHash || row.content_hash !== originalHash || (computedHash !== originalHash && !omittedTooLargeText)) {
        throw new Error(`Restored article content hash mismatch for ${row.id}`);
      }
      verified += 1;
    }
    if (batchRows.length < 10) break;
    const last = batchRows[batchRows.length - 1];
    if (!last) break;
    cursor = last.id;
  }
  if (verified !== expected.size) throw new Error("Restored article count does not match the export");
  return verified;
}

export async function restoreParsedExport(db: D1Database, parsed: ParsedExport): Promise<RestoreResult> {
  await assertEmptyTarget(db);

  for (const batch of chunk(parsed.sources, 20)) {
    await db.batch(batch.map((row) => insertStatement(db, "sources", SOURCE_COLUMNS, row)));
  }
  for (const batch of chunk(parsed.pending_items, 20)) {
    await db.batch(batch.map((row) => insertStatement(db, "pending_items", PENDING_COLUMNS, row)));
  }
  for (const batch of chunk(parsed.articles, 10)) {
    const statements = batch.flatMap((row) => [
      insertStatement(db, "articles", ARTICLE_COLUMNS, row),
      db.prepare("INSERT INTO articles_fts (article_id, title, snippet) VALUES (?, ?, ?)")
        .bind(row.id, row.title, typeof row.summary === "string" ? row.summary : ""),
    ]);
    await db.batch(statements);
  }

  const actualCounts = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sources) AS sources,
      (SELECT COUNT(*) FROM pending_items) AS pending_items,
      (SELECT COUNT(*) FROM articles) AS articles
  `).first<ExportCounts>();
  const counts: ExportCounts = {
    sources: Number(actualCounts?.sources ?? 0),
    pending_items: Number(actualCounts?.pending_items ?? 0),
    articles: Number(actualCounts?.articles ?? 0),
  };
  if (
    counts.sources !== parsed.manifest.counts.sources ||
    counts.pending_items !== parsed.manifest.counts.pending_items ||
    counts.articles !== parsed.manifest.counts.articles
  ) {
    throw new Error("Restored row counts do not match the export manifest");
  }
  const expectedHashes = new Map(parsed.articles.map((article) => [article.id, article.content_hash]));
  const verifiedArticleHashes = await verifyRestoredArticles(db, expectedHashes);
  return { counts, verified_article_hashes: verifiedArticleHashes };
}

export async function restoreExport(db: D1Database, ndjson: string): Promise<RestoreResult> {
  return await restoreParsedExport(db, await parseExportNdjson(ndjson));
}

export type { ExportRecord };
