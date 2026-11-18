import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { LoadingError } from "../components/LoadingError";
import { StatusBadge } from "../components/StatusBadge";

interface RunItem {
  id: string;
  source_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
  duration_seconds: number;
}

interface RunSource {
  source_id_snapshot: string;
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
}

interface RunPageResult {
  runs: RunItem[];
  next_cursor: string | null;
}

interface RunDetailResult {
  run: RunItem;
  sources: RunSource[];
}

interface SourceOption {
  id: string;
  host: string;
}

interface RunFilters {
  status: string;
  sourceId: string;
  limit: number;
}

interface RunsPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
}

const DEFAULT_FILTERS: RunFilters = { status: "", sourceId: "", limit: 20 };
const RUN_STATUSES = ["running", "succeeded", "partial", "failed", "blocked", "storage_limit"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunItem(value: unknown): value is RunItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    (value.source_id === null || typeof value.source_id === "string") &&
    typeof value.started_at === "number" &&
    (value.finished_at === null || typeof value.finished_at === "number") &&
    typeof value.status === "string" &&
    (value.http_status === null || typeof value.http_status === "number") &&
    typeof value.discovered_count === "number" &&
    typeof value.stored_count === "number" &&
    (value.error_code === null || typeof value.error_code === "string") &&
    (value.error_message === null || typeof value.error_message === "string") &&
    typeof value.duration_seconds === "number";
}

function isRunPage(payload: unknown): payload is RunPageResult {
  return isRecord(payload) && Array.isArray(payload.runs) && payload.runs.every(isRunItem) &&
    (payload.next_cursor === null || typeof payload.next_cursor === "string");
}

function isRunSource(value: unknown): value is RunSource {
  return isRecord(value) && typeof value.source_id_snapshot === "string" && typeof value.status === "string" &&
    (value.http_status === null || typeof value.http_status === "number") &&
    typeof value.discovered_count === "number" && typeof value.stored_count === "number" &&
    (value.error_code === null || typeof value.error_code === "string") &&
    (value.error_message === null || typeof value.error_message === "string");
}

function isRunDetail(payload: unknown): payload is RunDetailResult {
  return isRecord(payload) && isRunItem(payload.run) && Array.isArray(payload.sources) && payload.sources.every(isRunSource);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function apiMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.length > 0) {
    return payload.error.message;
  }
  return `Run request failed (HTTP ${status})`;
}

function timeLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Time unavailable";
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function durationLabel(seconds: number): string {
  return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds)} seconds` : "Duration unavailable";
}

function countLabel(discovered: number, stored: number): string {
  return `${discovered} discovered · ${stored} stored`;
}

function httpLabel(status: number | null): string {
  return status === null ? "HTTP status unavailable" : `HTTP ${status}`;
}

export function RunsPage({ session }: RunsPageProps) {
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<RunFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<RunFilters>(DEFAULT_FILTERS);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<RunPageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<Record<string, { loading: boolean; error: string | null; result: RunDetailResult | null }>>({});

  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const response = await apiRequest(session, "/v1/sources");
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isRecord(payload) || !Array.isArray(payload.sources)) throw new Error("The source list response was not recognized");
      const options = payload.sources.filter((source): source is SourceOption =>
        isRecord(source) && typeof source.id === "string" && typeof source.host === "string",
      );
      setSources(options);
    } catch (caught) {
      setSourcesError(caught instanceof Error ? caught.message : "Source options could not be loaded");
    }
  }, [session]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const currentCursor = cursorHistory[pageIndex] ?? null;
  const loadRuns = useCallback(async (isActive: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(filters.limit));
      if (filters.status !== "") params.set("status", filters.status);
      if (filters.sourceId !== "") params.set("source_id", filters.sourceId);
      if (currentCursor !== null) params.set("cursor", currentCursor);
      const response = await apiRequest(session, `/v1/runs?${params.toString()}`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isRunPage(payload)) throw new Error("The run list response was not recognized");
      if (isActive()) setPage(payload);
    } catch (caught) {
      if (isActive()) setLoadError(caught instanceof Error ? caught.message : "Run history could not be loaded");
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [currentCursor, filters, session]);

  useEffect(() => {
    let active = true;
    void loadRuns(() => active);
    return () => { active = false; };
  }, [loadRuns]);

  const changeDraft = (key: keyof RunFilters, value: string) => {
    setDraftFilters((current) => ({ ...current, [key]: key === "limit" ? Number(value) : value }));
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(draftFilters);
    setCursorHistory([null]);
    setPageIndex(0);
    setExpandedRunId(null);
  };

  const goToNextPage = () => {
    if (page?.next_cursor === null || page?.next_cursor === undefined) return;
    const nextCursor = page.next_cursor;
    setCursorHistory((history) => [...history.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((index) => index + 1);
    setExpandedRunId(null);
  };

  const goToPreviousPage = () => {
    if (pageIndex === 0) return;
    setPageIndex((index) => index - 1);
    setExpandedRunId(null);
  };

  const loadSourceDetails = async (runId: string) => {
    setDetailState((current) => ({ ...current, [runId]: { loading: true, error: null, result: null } }));
    try {
      const response = await apiRequest(session, `/v1/runs/${encodeURIComponent(runId)}`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isRunDetail(payload)) throw new Error("The run detail response was not recognized");
      setDetailState((current) => ({ ...current, [runId]: { loading: false, error: null, result: payload } }));
    } catch (caught) {
      setDetailState((current) => ({ ...current, [runId]: { loading: false, error: caught instanceof Error ? caught.message : "Run details could not be loaded", result: null } }));
    }
  };

  const toggleSourceDetails = (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    const existing = detailState[runId];
    if (existing?.result !== null && existing?.result !== undefined) return;
    if (existing?.loading) return;
    void loadSourceDetails(runId);
  };

  const sourceHostById = new Map(sources.map((source) => [source.id, source.host]));

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Operational history</p>
        <h2>Runs</h2>
        <p>Review recent fetch activity, per-source outcomes, and sanitized run errors. History is limited to the last 30 days.</p>
      </header>

      <form className="form-card run-filters" onSubmit={applyFilters}>
        <h3>Filter runs</h3>
        <div className="run-filter-grid">
          <label className="form-field" htmlFor="run-status-filter">
            Run status
            <select id="run-status-filter" value={draftFilters.status} onChange={(event) => changeDraft("status", event.currentTarget.value)}>
              <option value="">All statuses</option>
              {RUN_STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label className="form-field" htmlFor="run-source-filter">
            Run source
            <select id="run-source-filter" value={draftFilters.sourceId} onChange={(event) => changeDraft("sourceId", event.currentTarget.value)}>
              <option value="">All sources</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.host} ({source.id})</option>)}
            </select>
          </label>
          <label className="form-field" htmlFor="run-page-size">
            Runs per page
            <select id="run-page-size" value={draftFilters.limit} onChange={(event) => changeDraft("limit", event.currentTarget.value)}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>
        {sourcesError !== null && <div className="run-source-error" role="alert"><p>Source options unavailable: {sourcesError}</p><button className="secondary-button" type="button" onClick={() => void loadSources()}>Retry sources</button></div>}
        <div className="run-filter-actions"><button type="submit">Apply filters</button></div>
      </form>

      <LoadingError loading={loading} error={loadError} onRetry={() => { void loadRuns(() => true); }}>
        {page !== null && page.runs.length === 0 ? (
          <section className="empty-state"><h3>No fetch runs match these filters</h3><p>Try another status or source.</p></section>
        ) : (
          <>
            <ol className="run-timeline" aria-label="Run timeline">
              {(page?.runs ?? []).map((run) => {
                const detail = detailState[run.id];
                const expanded = expandedRunId === run.id;
                return (
                  <li className="run-timeline-item" key={run.id}>
                    <article className="run-card">
                      <header className="run-card-header">
                        <div><p className="run-time">{timeLabel(run.started_at)}</p><h3>Run {run.id}</h3></div>
                        <StatusBadge status={run.status} />
                      </header>
                      <dl className="run-metadata">
                        <div><dt>Duration</dt><dd>{durationLabel(run.duration_seconds)}</dd></div>
                        <div><dt>HTTP status</dt><dd>{httpLabel(run.http_status)}</dd></div>
                        <div><dt>Started</dt><dd>{timeLabel(run.started_at)}</dd></div>
                      </dl>
                      <p className="run-counts">{countLabel(run.discovered_count, run.stored_count)}</p>
                      {run.error_code !== null && <p className="run-error-code">Error code: <code>{run.error_code}</code></p>}
                      {run.error_message !== null && <p className="error-copy run-error-message">{run.error_message}</p>}
                      <button className="secondary-button run-detail-toggle" type="button" aria-expanded={expanded} onClick={() => toggleSourceDetails(run.id)}>
                        {expanded ? "Hide source details" : "Show source details"}
                      </button>
                      {expanded && (
                        <section className="run-source-details" aria-label={`Source details for run ${run.id}`}>
                          <h4>Per-source results</h4>
                          {detail?.loading && <p className="loading-message" role="status">Loading source details…</p>}
                          {detail?.error !== null && detail?.error !== undefined && <div className="run-detail-error" role="alert"><p>{detail.error}</p><button className="secondary-button" type="button" onClick={() => { void loadSourceDetails(run.id); }}>Retry source details</button></div>}
                          {detail?.result?.sources.length === 0 && <p className="empty-message">No per-source records were stored for this run.</p>}
                          {detail?.result?.sources.map((source) => (
                            <article className="run-source-card" key={source.source_id_snapshot}>
                              <header><h5>{sourceHostById.get(source.source_id_snapshot) ?? "Source"}</h5><StatusBadge status={source.status} /></header>
                              <p className="source-id">Source ID: {source.source_id_snapshot}</p>
                              <dl className="run-source-metadata">
                                <div><dt>HTTP status</dt><dd>{httpLabel(source.http_status)}</dd></div>
                                <div><dt>Counts</dt><dd>{countLabel(source.discovered_count, source.stored_count)}</dd></div>
                              </dl>
                              {source.error_code !== null && <p className="run-error-code">Error code: <code>{source.error_code}</code></p>}
                              {source.error_message !== null && <p className="error-copy run-error-message">{source.error_message}</p>}
                            </article>
                          ))}
                        </section>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
            {page !== null && page.runs.length > 0 && (
              <nav className="run-pagination" aria-label="Run pages">
                <button className="secondary-button" type="button" disabled={pageIndex === 0 || loading} onClick={goToPreviousPage}>Previous page</button>
                <span>Page {pageIndex + 1}</span>
                <button className="secondary-button" type="button" disabled={page.next_cursor === null || loading} onClick={goToNextPage}>Next page</button>
              </nav>
            )}
          </>
        )}
      </LoadingError>
    </div>
  );
}
