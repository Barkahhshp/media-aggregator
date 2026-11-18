import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBackupFilename,
  downloadExport,
} from "../src/exports/export-client";
import type {
  ExportSnapshot,
  ExportWriter,
} from "../src/exports/export-client";

const snapshot: ExportSnapshot = {
  id: "export-session-1",
  snapshot_id: "snapshot-1",
  counts: { sources: 1, pending_items: 1, articles: 1 },
  expires_at: 2_000_000_000,
  cursor: "server-cursor-after-an-earlier-page",
};

function makePage(nextCursor: string | null, options: { snapshotId?: string; counts?: ExportSnapshot["counts"]; records?: unknown[] } = {}): string {
  const manifest = {
    type: "manifest",
    schema_version: 1,
    snapshot_id: options.snapshotId ?? snapshot.snapshot_id,
    export_watermark: "1800000000",
    exported_at: 1_800_000_000,
    counts: options.counts ?? snapshot.counts,
    full_text_encoding: "base64-utf8",
    next_cursor: nextCursor,
  };
  return `${[manifest, ...(options.records ?? [])].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function record(type: "source" | "pending" | "article", id: string) {
  return { type, record: { id } };
}

function makeWriter() {
  const writes: string[] = [];
  const writer: ExportWriter = {
    write: vi.fn(async (chunk: string) => { writes.push(chunk); }),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  return { writer, writes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("export download client", () => {
  it("follows opaque cursors, validates each page manifest, writes pages, and reports progress", async () => {
    const firstPage = makePage("cursor+/next==", { records: [record("source", "source-1")] });
    const secondPage = makePage(null, { records: [record("pending", "pending-1"), record("article", "article-1")] });
    const readPage = vi.fn(async (cursor: string | null) => cursor === null ? firstPage : secondPage);
    const endSession = vi.fn(async () => true);
    const { writer, writes } = makeWriter();
    const progress: Array<{ pages: number; records: number; totalRecords: number }> = [];

    const result = await downloadExport({
      snapshot,
      readPage,
      endSession,
      output: { kind: "stream", writer },
      onProgress: (value) => progress.push(value),
    });

    expect(readPage.mock.calls).toEqual([[null], ["cursor+/next=="]]);
    expect(writes).toEqual([firstPage, secondPage]);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ pages: 2, records: 3, cleanupConfirmed: true, expiresAt: snapshot.expires_at });
    expect(result.blob).toBeNull();
    expect(progress).toEqual([
      { pages: 1, records: 1, totalRecords: 3 },
      { pages: 2, records: 3, totalRecords: 3 },
    ]);
  });

  it("restarts at the first page for an active snapshot instead of trusting its saved server cursor", async () => {
    const readPage = vi.fn(async () => makePage(null, {
      records: [record("source", "source-1"), record("pending", "pending-1"), record("article", "article-1")],
    }));
    const result = await downloadExport({
      snapshot,
      readPage,
      endSession: async () => true,
      output: { kind: "blob" },
    });

    expect(readPage).toHaveBeenCalledWith(null);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(await result.blob?.text()).toContain('"snapshot_id":"snapshot-1"');
    expect(result.records).toBe(3);
  });

  it("rejects an inconsistent snapshot manifest and attempts to abort and end the session", async () => {
    const readPage = vi.fn(async () => makePage(null, {
      snapshotId: "another-snapshot",
      records: [record("source", "source-1")],
    }));
    const endSession = vi.fn(async () => true);
    const { writer } = makeWriter();

    await expect(downloadExport({
      snapshot,
      readPage,
      endSession,
      output: { kind: "stream", writer },
    })).rejects.toMatchObject({
      cleanupConfirmed: true,
      expiresAt: snapshot.expires_at,
    });

    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("rejects a cursor loop and never publishes an incomplete Blob", async () => {
    const readPage = vi.fn(async () => makePage("loop-cursor", { records: [record("source", "source-1")] }));
    const endSession = vi.fn(async () => true);

    await expect(downloadExport({
      snapshot,
      readPage,
      endSession,
      output: { kind: "blob" },
    })).rejects.toMatchObject({ complete: false, cleanupConfirmed: true });

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("does not produce a complete Blob when the final record counts differ from the snapshot", async () => {
    const endSession = vi.fn(async () => true);

    await expect(downloadExport({
      snapshot,
      readPage: async () => makePage(null, { records: [record("source", "source-1")] }),
      endSession,
      output: { kind: "blob" },
    })).rejects.toMatchObject({ complete: false, cleanupConfirmed: true });
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("aborts a failed streaming write, attempts cleanup, and retains expiry context", async () => {
    const writer = makeWriter().writer;
    vi.mocked(writer.write).mockRejectedValueOnce(new Error("disk write failed"));
    const endSession = vi.fn(async () => true);

    await expect(downloadExport({
      snapshot,
      readPage: async () => makePage(null, {
        records: [record("source", "source-1"), record("pending", "pending-1"), record("article", "article-1")],
      }),
      endSession,
      output: { kind: "stream", writer },
    })).rejects.toMatchObject({
      complete: false,
      cleanupConfirmed: true,
      expiresAt: snapshot.expires_at,
    });

    expect(writer.abort).toHaveBeenCalledOnce();
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("returns the complete Blob when cleanup cannot be confirmed and preserves expiry", async () => {
    const result = await downloadExport({
      snapshot,
      readPage: async () => makePage(null, {
        records: [record("source", "source-1"), record("pending", "pending-1"), record("article", "article-1")],
      }),
      endSession: async () => false,
      output: { kind: "blob" },
    });

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.complete).toBe(true);
    expect(result.cleanupConfirmed).toBe(false);
    expect(result.expiresAt).toBe(snapshot.expires_at);
  });

  it("attempts end after an expired page request without producing a backup", async () => {
    const endSession = vi.fn(async () => false);

    await expect(downloadExport({
      snapshot,
      readPage: async () => { throw new Error("Export session expired (HTTP 410)"); },
      endSession,
      output: { kind: "blob" },
    })).rejects.toMatchObject({
      complete: false,
      cleanupConfirmed: false,
      expiresAt: snapshot.expires_at,
    });
    expect(endSession).toHaveBeenCalledOnce();
  });

  it("returns an NDJSON filename that cannot contain the API token", () => {
    const apiToken = "api-token-must-not-appear";
    const filename = createBackupFilename(new Date("2026-11-19T00:00:00.000Z"));

    expect(filename).toMatch(/^media-aggregator-backup-.*\.ndjson$/u);
    expect(filename).not.toContain(apiToken);
  });
});
