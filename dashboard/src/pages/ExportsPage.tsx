import { useCallback, useEffect, useState } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import {
  createBackupFilename,
  downloadExport,
  ExportDownloadError,
} from "../exports/export-client";
import type {
  ExportOutput,
  ExportProgress,
  ExportSnapshot,
  ExportWriter,
} from "../exports/export-client";

interface ExportsPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
}

interface DownloadLink {
  url: string;
  filename: string;
}

interface SnapshotDisplay {
  snapshot_id: string;
  counts: ExportSnapshot["counts"] | null;
  expires_at: number;
}

interface BrowserFileWriter {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface BrowserFileHandle {
  createWritable(): Promise<BrowserFileWriter>;
}

interface FilePickerOptions {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

type WindowWithFilePicker = Window & {
  showSaveFilePicker?: (options: FilePickerOptions) => Promise<BrowserFileHandle>;
};

interface PreparedOutput {
  output: ExportOutput;
  filename: string;
  streaming: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCounts(value: unknown): value is ExportSnapshot["counts"] {
  return isObject(value) && [value.sources, value.pending_items, value.articles]
    .every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}

function validSnapshot(value: unknown): value is ExportSnapshot {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.snapshot_id === "string" && value.snapshot_id.length > 0 &&
    validCounts(value.counts) && Number.isSafeInteger(value.expires_at) && Number(value.expires_at) > 0 &&
    (value.cursor === null || typeof value.cursor === "string");
}

function errorMessage(message: string, status: number): string {
  return `${message} (HTTP ${status})`;
}

async function readActiveExport(session: ExportsPageProps["session"]): Promise<ExportSnapshot | null> {
  const response = await apiRequest(session, "/v1/exports/active");
  if (!response.ok) throw new Error(errorMessage("Active export status could not be loaded", response.status));
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error("Active export status returned an invalid response");
  }
  if (!isObject(payload) || !("session" in payload)) {
    throw new Error("Active export status returned an invalid response");
  }
  if (payload.session === null) return null;
  if (!validSnapshot(payload.session)) throw new Error("Active export details were not recognized");
  return payload.session;
}

async function readStartedSession(session: ExportsPageProps["session"]): Promise<{ id: string; snapshot_id: string; expires_at: number }> {
  const response = await apiRequest(session, "/v1/exports", { method: "POST" });
  if (!response.ok) throw new Error(errorMessage("A new export could not be started", response.status));
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error("The new export returned an invalid response");
  }
  if (!isObject(payload) || !isObject(payload.session)) throw new Error("The new export returned an invalid response");
  const value = payload.session;
  if (
    typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.snapshot_id !== "string" || value.snapshot_id.length === 0 ||
    !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= 0
  ) {
    throw new Error("The new export returned incomplete session details");
  }
  return { id: value.id, snapshot_id: value.snapshot_id, expires_at: Number(value.expires_at) };
}

function countsLabel(snapshot: SnapshotDisplay): string {
  if (snapshot.counts === null) return "Record counts unavailable";
  const { sources, pending_items: pendingItems, articles } = snapshot.counts;
  return `${sources} ${sources === 1 ? "source" : "sources"}, ${pendingItems} pending ${pendingItems === 1 ? "item" : "items"}, ${articles} ${articles === 1 ? "article" : "articles"}`;
}

function expiryLabel(value: number): { dateTime: string | null; text: string } {
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return { dateTime: null, text: "Expiry time unavailable" };
  return {
    dateTime: date.toISOString(),
    text: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date),
  };
}

function isCancelled(error: unknown): boolean {
  return isObject(error) && error.name === "AbortError";
}

async function prepareOutput(): Promise<PreparedOutput | null> {
  const filename = createBackupFilename();
  const picker = (window as WindowWithFilePicker).showSaveFilePicker;
  if (picker === undefined) return { output: { kind: "blob" }, filename, streaming: false };

  try {
    const handle = await picker.call(window, {
      suggestedName: filename,
      types: [{ description: "NDJSON backup", accept: { "application/x-ndjson": [".ndjson"] } }],
    });
    const browserWriter = await handle.createWritable();
    const writer: ExportWriter = {
      write: async (chunk) => browserWriter.write(chunk),
      close: () => browserWriter.close(),
      abort: async () => browserWriter.abort?.(),
    };
    return { output: { kind: "stream", writer }, filename, streaming: true };
  } catch (error) {
    if (isCancelled(error)) return null;
    throw new Error("The backup file could not be prepared; no export lock was acquired", { cause: error });
  }
}

async function abortPreparedOutput(prepared: PreparedOutput): Promise<void> {
  if (prepared.output.kind !== "stream") return;
  try {
    await prepared.output.writer.abort?.();
  } catch {
    // No server lock has been acquired in this path; preserve the original UI outcome.
  }
}

function formatProgress(progress: ExportProgress): string {
  return `${progress.pages} ${progress.pages === 1 ? "page" : "pages"}, ${progress.records} of ${progress.totalRecords} records`;
}

export function ExportsPage({ session }: ExportsPageProps) {
  const [activeSnapshot, setActiveSnapshot] = useState<ExportSnapshot | null>(null);
  const [displayedSnapshot, setDisplayedSnapshot] = useState<SnapshotDisplay | null>(null);
  const [checking, setChecking] = useState(true);
  const [activeError, setActiveError] = useState<string | null>(null);
  const [operation, setOperation] = useState<"starting" | "downloading" | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [downloadLink, setDownloadLink] = useState<DownloadLink | null>(null);
  const [streamingSaved, setStreamingSaved] = useState(false);

  const refreshActive = useCallback(async (isActive: () => boolean = () => true) => {
    setChecking(true);
    setActiveError(null);
    try {
      const active = await readActiveExport(session);
      if (!isActive()) return;
      setActiveSnapshot(active);
      setDisplayedSnapshot(active);
      setNotice(active === null ? null : "An active export lock is in place.");
      setTransferError(null);
    } catch (error) {
      if (isActive()) setActiveError(error instanceof Error ? error.message : "Active export status could not be loaded");
    } finally {
      if (isActive()) setChecking(false);
    }
  }, [session]);

  useEffect(() => {
    let active = true;
    void refreshActive(() => active);
    return () => { active = false; };
  }, [refreshActive]);

  useEffect(() => () => {
    if (downloadLink !== null) URL.revokeObjectURL(downloadLink.url);
  }, [downloadLink]);

  const runDownload = async (snapshot: ExportSnapshot, prepared: PreparedOutput) => {
    setOperation("downloading");
    setActiveSnapshot(snapshot);
    setDisplayedSnapshot(snapshot);
    setProgress({ pages: 0, records: 0, totalRecords: snapshot.counts.sources + snapshot.counts.pending_items + snapshot.counts.articles });
    setTransferError(null);
    setNotice("Export lock active — downloading the snapshot.");
    setDownloadLink(null);
    setStreamingSaved(false);

    try {
      const result = await downloadExport({
        snapshot,
        output: prepared.output,
        readPage: async (cursor) => {
          const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
          const response = await apiRequest(session, `/v1/exports/${encodeURIComponent(snapshot.id)}${query}`);
          if (response.status === 410) throw new Error("The export expired before the backup finished (HTTP 410)");
          if (!response.ok) throw new Error(errorMessage("An export page could not be downloaded", response.status));
          return await response.text();
        },
        endSession: async () => {
          const response = await apiRequest(session, `/v1/exports/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" });
          return response.ok;
        },
        onProgress: setProgress,
      });

      if (result.blob !== null) {
        const url = URL.createObjectURL(result.blob);
        setDownloadLink({ url, filename: prepared.filename });
      } else {
        setStreamingSaved(true);
      }
      if (result.cleanupConfirmed) {
        setActiveSnapshot(null);
        setNotice("Backup is ready. Export lock released.");
      } else {
        setActiveSnapshot(snapshot);
        setNotice(`Backup is ready, but cleanup could not be confirmed. The export lock may remain until ${expiryLabel(result.expiresAt).text}.`);
      }
    } catch (error) {
      const details = error instanceof ExportDownloadError
        ? error
        : new ExportDownloadError(
          error instanceof Error ? error.message : "The backup did not complete",
          { cleanupConfirmed: false, cleanupError: "The export lock cleanup could not be confirmed", expiresAt: snapshot.expires_at },
        );
      setTransferError(`Backup incomplete: ${details.message}`);
      if (details.cleanupConfirmed) {
        setActiveSnapshot(null);
        setNotice("Export lock released.");
      } else {
        setActiveSnapshot(snapshot);
        setNotice(`Cleanup could not be confirmed. The lock may remain until ${expiryLabel(details.expiresAt).text}.`);
      }
    } finally {
      setOperation(null);
    }
  };

  const startNewExport = async () => {
    setTransferError(null);
    setNotice(null);
    setProgress(null);
    setDownloadLink(null);
    setStreamingSaved(false);
    setOperation("starting");

    let prepared: PreparedOutput | null;
    try {
      prepared = await prepareOutput();
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "The backup file could not be prepared");
      setOperation(null);
      return;
    }
    if (prepared === null) {
      setNotice("File selection was cancelled. No export lock was acquired.");
      setOperation(null);
      return;
    }

    let started: { id: string; snapshot_id: string; expires_at: number };
    try {
      started = await readStartedSession(session);
    } catch (error) {
      await abortPreparedOutput(prepared);
      setTransferError(error instanceof Error ? error.message : "A new export could not be started");
      setOperation(null);
      return;
    }

    let active: ExportSnapshot | null;
    try {
      active = await readActiveExport(session);
    } catch (error) {
      await abortPreparedOutput(prepared);
      const cleanupConfirmed = await endExport(session, started.id);
      setDisplayedSnapshot({ snapshot_id: started.snapshot_id, counts: null, expires_at: started.expires_at });
      setActiveSnapshot(null);
      setActiveError(error instanceof Error ? error.message : "The started snapshot could not be verified");
      setTransferError(null);
      setNotice(cleanupConfirmed
        ? "Export lock released."
        : `Cleanup could not be confirmed. The lock may remain until ${expiryLabel(started.expires_at).text}.`);
      setOperation(null);
      return;
    }

    if (active === null || active.id !== started.id || active.snapshot_id !== started.snapshot_id) {
      await abortPreparedOutput(prepared);
      const cleanupConfirmed = await endExport(session, started.id);
      const partialSnapshot: SnapshotDisplay = { snapshot_id: started.snapshot_id, counts: null, expires_at: started.expires_at };
      setDisplayedSnapshot(partialSnapshot);
      setActiveSnapshot(null);
      setActiveError("The new export could not be matched to its active snapshot");
      setTransferError(null);
      setNotice(cleanupConfirmed
        ? "Export lock released."
        : `Cleanup could not be confirmed. The lock may remain until ${expiryLabel(started.expires_at).text}.`);
      setOperation(null);
      return;
    }

    await runDownload(active, prepared);
  };

  const recoverActiveExport = async () => {
    if (activeSnapshot === null) return;
    setTransferError(null);
    setNotice(null);
    setOperation("starting");
    let prepared: PreparedOutput | null;
    try {
      prepared = await prepareOutput();
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "The backup file could not be prepared");
      setOperation(null);
      return;
    }
    if (prepared === null) {
      setNotice("File selection was cancelled. The active export remains available until it expires.");
      setOperation(null);
      return;
    }
    await runDownload(activeSnapshot, prepared);
  };

  const shownSnapshot = activeSnapshot ?? displayedSnapshot;
  const expiry = shownSnapshot === null ? null : expiryLabel(shownSnapshot.expires_at);
  const lockText = operation === "starting"
    ? "Preparing backup file…"
    : operation === "downloading"
      ? "Export lock active — downloading"
      : activeSnapshot !== null
        ? "Export lock active"
        : notice?.includes("Cleanup could not be confirmed") || notice?.includes("cleanup could not be confirmed")
          ? "Export lock cleanup unconfirmed"
          : "Export lock released";
  const totalRecords = progress?.totalRecords ?? 0;

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Portable database snapshot</p>
        <h2>Exports and Backups</h2>
        <p>Download a complete NDJSON snapshot of sources, pending items, and articles. The export lock is released after the download attempt or remains only until its displayed expiry if cleanup cannot be confirmed.</p>
      </header>

      <aside className="export-warning" aria-label="Before starting an export">
        <h3>Before you start</h3>
        <p>Export lock pauses the scheduler and blocks source changes while the snapshot is being downloaded. It is a temporary lock, not an archive or remote restore service.</p>
        <p>If this page reloads, recovery starts again at page one of the same snapshot so the new backup is complete; it never resumes from a later page as if the remainder were a full backup.</p>
      </aside>

      {checking ? (
        <p className="loading-message" role="status">Checking for an active export…</p>
      ) : activeError !== null ? (
        <section className="error-panel" role="alert">
          <p>{activeError}</p>
          <button className="secondary-button" type="button" onClick={() => void refreshActive()}>Retry status check</button>
        </section>
      ) : null}

      {activeSnapshot !== null && (
        <section className="export-summary" aria-labelledby="active-export-title">
          <div className="export-summary-header">
            <div>
              <p className="eyebrow">Current lock state</p>
              <h3 id="active-export-title">Active backup snapshot</h3>
            </div>
            <span className="status-badge status-badge--caution">{lockText}</span>
          </div>
          <dl className="export-metadata">
            <div><dt>Snapshot ID</dt><dd className="mono-text">{activeSnapshot.snapshot_id}</dd></div>
            <div><dt>Records in snapshot</dt><dd>{countsLabel(activeSnapshot)}</dd></div>
            <div><dt>Lock expires</dt><dd>{expiry?.dateTime === null ? expiry?.text : <time dateTime={expiry?.dateTime ?? undefined}>{expiry?.text}</time>}</dd></div>
          </dl>
          {progress !== null && (
            <div className="export-progress" aria-live="polite">
              <progress aria-label="Backup record progress" max={Math.max(totalRecords, 1)} value={Math.min(progress.records, Math.max(totalRecords, 1))} />
              <p>{formatProgress(progress)}</p>
            </div>
          )}
          {operation === null && (
            <button type="button" onClick={() => void recoverActiveExport()}>
              {transferError === null ? "Download complete backup" : "Retry full download from the start"}
            </button>
          )}
        </section>
      )}

      {displayedSnapshot !== null && activeSnapshot === null && (
        <section className="export-summary" aria-label="Last export snapshot">
          <div className="export-summary-header">
            <div>
              <p className="eyebrow">Last snapshot</p>
              <h3>Backup snapshot details</h3>
            </div>
            <span className="status-badge status-badge--good">{lockText}</span>
          </div>
          <dl className="export-metadata">
            <div><dt>Snapshot ID</dt><dd className="mono-text">{displayedSnapshot.snapshot_id}</dd></div>
            <div><dt>Records in snapshot</dt><dd>{countsLabel(displayedSnapshot)}</dd></div>
            <div><dt>Lock expiry</dt><dd>{expiry?.dateTime === null ? expiry?.text : <time dateTime={expiry?.dateTime ?? undefined}>{expiry?.text}</time>}</dd></div>
          </dl>
          {progress !== null && <p className="export-progress-label">{formatProgress(progress)}</p>}
        </section>
      )}

      {transferError !== null && <section className="export-error" role="alert"><p>{transferError}</p></section>}
      {notice !== null && <p className="export-notice" role="status">{notice}</p>}
      {operation === "starting" && <p className="loading-message" role="status">Preparing the backup. No partial file will be marked complete.</p>}
      {operation === "downloading" && <p className="loading-message" role="status">Downloading snapshot page by page…</p>}
      {downloadLink !== null && (
        <section className="export-download-ready" aria-label="Backup is ready">
          <h3>Backup is ready</h3>
          <p>The completed NDJSON file is ready to save. The file contains the snapshot pages and no dashboard API credential.</p>
          <a href={downloadLink.url} download={downloadLink.filename}>Download backup file</a>
        </section>
      )}
      {streamingSaved && (
        <section className="export-download-ready" aria-label="Backup is ready">
          <h3>Backup is ready</h3>
          <p>The complete NDJSON snapshot was written to the file you selected.</p>
        </section>
      )}

      {activeSnapshot === null && operation === null && activeError === null && (
        <section className="export-start-card">
          {displayedSnapshot === null && <p>No active export lock. Starting an export will create a new snapshot and acquire the lock.</p>}
          <button type="button" disabled={checking} onClick={() => void startNewExport()}>
            I understand — start backup
          </button>
        </section>
      )}

      {operation === null && typeof (window as WindowWithFilePicker).showSaveFilePicker !== "function" && (
        <p className="export-memory-note">This browser does not support incremental file writing here. The fallback keeps the full backup in memory until it is ready to download; large snapshots can use substantial browser memory.</p>
      )}

      <section className="local-restore-note">
        <h3>Restore locally</h3>
        <p>Restore is available only through the existing local CLI workflow from your project checkout:</p>
        <code>npm run restore:export -- &lt;backup.ndjson&gt;</code>
        <p>This dashboard does not restore to a remote database and does not provide archival retention or a whole-backup checksum.</p>
      </section>
    </div>
  );
}

async function endExport(session: ExportsPageProps["session"], id: string): Promise<boolean> {
  try {
    const response = await apiRequest(session, `/v1/exports/${encodeURIComponent(id)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
