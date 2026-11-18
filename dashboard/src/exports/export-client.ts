export interface ExportCounts {
  sources: number;
  pending_items: number;
  articles: number;
}

export interface ExportSnapshot {
  id: string;
  snapshot_id: string;
  counts: ExportCounts;
  expires_at: number;
  cursor: string | null;
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

export interface ExportWriter {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface ExportProgress {
  pages: number;
  records: number;
  totalRecords: number;
}

export type ExportOutput =
  | { kind: "stream"; writer: ExportWriter }
  | { kind: "blob" };

export interface DownloadExportOptions {
  snapshot: ExportSnapshot;
  readPage(cursor: string | null): Promise<string>;
  endSession(): Promise<boolean>;
  output: ExportOutput;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportDownloadResult {
  complete: true;
  pages: number;
  records: number;
  cleanupConfirmed: boolean;
  cleanupError: string | null;
  expiresAt: number;
  blob: Blob | null;
}

export class ExportDownloadError extends Error {
  readonly complete = false;
  readonly cleanupConfirmed: boolean;
  readonly cleanupError: string | null;
  readonly expiresAt: number;

  constructor(
    message: string,
    options: { cleanupConfirmed: boolean; cleanupError: string | null; expiresAt: number },
  ) {
    super(message);
    this.name = "ExportDownloadError";
    this.cleanupConfirmed = options.cleanupConfirmed;
    this.cleanupError = options.cleanupError;
    this.expiresAt = options.expiresAt;
  }
}

interface ParsedPage {
  manifest: ExportManifest;
  recordCounts: ExportCounts;
  recordCount: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseCounts(value: unknown): ExportCounts {
  if (!isObject(value) || !isCount(value.sources) || !isCount(value.pending_items) || !isCount(value.articles)) {
    throw new Error("The export manifest contains invalid record counts");
  }
  return {
    sources: value.sources,
    pending_items: value.pending_items,
    articles: value.articles,
  };
}

function sameCounts(left: ExportCounts, right: ExportCounts): boolean {
  return left.sources === right.sources
    && left.pending_items === right.pending_items
    && left.articles === right.articles;
}

function parsePage(text: string): ParsedPage {
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("An export page was empty or incomplete");
  }
  const lines = text.slice(0, -1).split(/\r?\n/u);
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) {
    throw new Error("An export page contains an empty NDJSON line");
  }

  let values: unknown[];
  try {
    values = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error("An export page contains invalid NDJSON");
  }

  const first = values[0];
  if (!isObject(first) || first.type !== "manifest") {
    throw new Error("An export page is missing its manifest");
  }
  const counts = parseCounts(first.counts);
  if (
    first.schema_version !== 1 ||
    typeof first.snapshot_id !== "string" || first.snapshot_id.length === 0 ||
    typeof first.export_watermark !== "string" || first.export_watermark.length === 0 ||
    !isCount(first.exported_at) ||
    first.full_text_encoding !== "base64-utf8" ||
    (first.next_cursor !== null && (typeof first.next_cursor !== "string" || first.next_cursor.length === 0 || first.next_cursor.length > 4096))
  ) {
    throw new Error("An export page has an unsupported or invalid manifest");
  }
  const manifest: ExportManifest = {
    type: "manifest",
    schema_version: 1,
    snapshot_id: first.snapshot_id,
    export_watermark: first.export_watermark,
    exported_at: first.exported_at,
    counts,
    full_text_encoding: "base64-utf8",
    next_cursor: first.next_cursor,
  };

  const recordCounts: ExportCounts = { sources: 0, pending_items: 0, articles: 0 };
  for (const value of values.slice(1)) {
    if (!isObject(value) || !isObject(value.record)) {
      throw new Error("An export page contains an invalid record");
    }
    if (value.type === "source") recordCounts.sources += 1;
    else if (value.type === "pending") recordCounts.pending_items += 1;
    else if (value.type === "article") recordCounts.articles += 1;
    else throw new Error("An export page contains an unknown record type");
  }
  return {
    manifest,
    recordCounts,
    recordCount: values.length - 1,
  };
}

function totalCount(counts: ExportCounts): number {
  return counts.sources + counts.pending_items + counts.articles;
}

function cleanupMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The export lock cleanup request failed";
}

export async function downloadExport(options: DownloadExportOptions): Promise<ExportDownloadResult> {
  const { snapshot, readPage, endSession, output, onProgress } = options;
  const counts = parseCounts(snapshot.counts);
  const expectedRecords = totalCount(counts);
  const collected: ExportCounts = { sources: 0, pending_items: 0, articles: 0 };
  const chunks: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstManifest: ExportManifest | null = null;
  let pages = 0;
  let transferError: unknown = null;
  let complete = false;

  try {
    while (true) {
      if (pages > expectedRecords) throw new Error("The export exceeded the snapshot record count");
      const text = await readPage(cursor);
      const page = parsePage(text);
      if (page.manifest.snapshot_id !== snapshot.snapshot_id || !sameCounts(page.manifest.counts, counts)) {
        throw new Error("An export page does not match the active snapshot");
      }
      if (firstManifest === null) {
        firstManifest = page.manifest;
      } else if (
        page.manifest.schema_version !== firstManifest.schema_version ||
        page.manifest.export_watermark !== firstManifest.export_watermark ||
        page.manifest.exported_at !== firstManifest.exported_at ||
        page.manifest.full_text_encoding !== firstManifest.full_text_encoding
      ) {
        throw new Error("The export contains inconsistent page manifests");
      }

      const nextCursor = page.manifest.next_cursor;
      if (nextCursor !== null && (nextCursor === cursor || seenCursors.has(nextCursor))) {
        throw new Error("The export page cursor repeated");
      }
      if (nextCursor !== null && page.recordCount === 0) {
        throw new Error("The export cursor advanced without returning any records");
      }

      collected.sources += page.recordCounts.sources;
      collected.pending_items += page.recordCounts.pending_items;
      collected.articles += page.recordCounts.articles;
      if (
        collected.sources > counts.sources ||
        collected.pending_items > counts.pending_items ||
        collected.articles > counts.articles
      ) {
        throw new Error("The export contains more records than the snapshot manifest");
      }

      if (output.kind === "stream") await output.writer.write(text);
      else chunks.push(text);

      pages += 1;
      onProgress?.({ pages, records: totalCount(collected), totalRecords: expectedRecords });
      if (nextCursor === null) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (!sameCounts(collected, counts)) {
      throw new Error("The export is incomplete because record counts do not match the snapshot");
    }
    if (output.kind === "stream") await output.writer.close();
    complete = true;
  } catch (error) {
    transferError = error;
    if (output.kind === "stream") {
      try {
        await output.writer.abort?.();
      } catch {
        // Preserve the transfer error; cleanup of the server lock still runs below.
      }
    }
  }

  let cleanupConfirmed = false;
  let cleanupError: string | null = null;
  try {
    cleanupConfirmed = await endSession();
    if (!cleanupConfirmed) cleanupError = "The export lock cleanup could not be confirmed";
  } catch (error) {
    cleanupError = cleanupMessage(error);
  }

  if (transferError !== null || !complete) {
    const message = transferError instanceof Error
      ? transferError.message
      : "The export did not complete";
    throw new ExportDownloadError(message, {
      cleanupConfirmed,
      cleanupError,
      expiresAt: snapshot.expires_at,
    });
  }

  return {
    complete: true,
    pages,
    records: totalCount(collected),
    cleanupConfirmed,
    cleanupError,
    expiresAt: snapshot.expires_at,
    blob: output.kind === "blob" ? new Blob(chunks, { type: "application/x-ndjson;charset=utf-8" }) : null,
  };
}

export function createBackupFilename(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return `media-aggregator-backup-${timestamp}.ndjson`;
}
