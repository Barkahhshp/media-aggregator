import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { safeApiErrorMessage } from "../api/safe-error";
import { LoadingError } from "../components/LoadingError";
import { StatusBadge } from "../components/StatusBadge";

interface ErrorSample {
  time: number;
  message: string | null;
}

interface ErrorGroup {
  origin: "run" | "pending";
  source_id: string;
  code: string;
  status: string;
  count: number;
  first_time: number;
  last_time: number;
  samples: ErrorSample[];
}

interface ErrorPageResult {
  errors: ErrorGroup[];
  next_cursor: string | null;
}

interface SourceOption {
  id: string;
  host: string;
}

interface PendingItem {
  id: string;
  source_id: string;
  item_type: string;
  title: string | null;
  status: string;
  attempts: number;
  next_attempt_at: number;
  terminal_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
}

interface PendingPageResult {
  pending: PendingItem[];
  next_cursor: string | null;
}

interface PendingPanelState {
  loading: boolean;
  error: string | null;
  pending: PendingItem[];
  nextCursor: string | null;
}

interface ErrorsPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
}

interface ErrorFilters {
  sourceId: string;
  limit: number;
}

const DEFAULT_FILTERS: ErrorFilters = { sourceId: "", limit: 20 };
const PENDING_STATUSES = ["pending", "retry_wait", "blocked", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorGroup(value: unknown): value is ErrorGroup {
  if (!isRecord(value) || (value.origin !== "run" && value.origin !== "pending")) return false;
  return typeof value.source_id === "string" && typeof value.code === "string" && typeof value.status === "string" &&
    typeof value.count === "number" && typeof value.first_time === "number" && typeof value.last_time === "number" &&
    Array.isArray(value.samples) && value.samples.every((sample) => isRecord(sample) && typeof sample.time === "number" && (sample.message === null || typeof sample.message === "string"));
}

function isErrorPage(payload: unknown): payload is ErrorPageResult {
  return isRecord(payload) && Array.isArray(payload.errors) && payload.errors.every(isErrorGroup) &&
    (payload.next_cursor === null || typeof payload.next_cursor === "string");
}

function isPendingItem(value: unknown): value is PendingItem {
  return isRecord(value) && typeof value.id === "string" && typeof value.source_id === "string" && typeof value.item_type === "string" &&
    (value.title === null || typeof value.title === "string") && typeof value.status === "string" && typeof value.attempts === "number" &&
    typeof value.next_attempt_at === "number" && (value.terminal_expires_at === null || typeof value.terminal_expires_at === "number") &&
    (value.error_code === null || typeof value.error_code === "string") && (value.error_message === null || typeof value.error_message === "string");
}

function isPendingPage(payload: unknown): payload is PendingPageResult {
  return isRecord(payload) && Array.isArray(payload.pending) && payload.pending.every(isPendingItem) &&
    (payload.next_cursor === null || typeof payload.next_cursor === "string");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function apiMessage(payload: unknown, status: number): string {
  return safeApiErrorMessage(payload, status, "Error");
}

function timeLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return "Time unavailable";
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function dateTimeValue(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function groupKey(group: ErrorGroup): string {
  return JSON.stringify([group.origin, group.source_id, group.code, group.status]);
}

function canDrillDown(group: ErrorGroup): boolean {
  return group.origin === "pending" && PENDING_STATUSES.includes(group.status);
}

export function ErrorsPage({ session }: ErrorsPageProps) {
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<ErrorFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<ErrorFilters>(DEFAULT_FILTERS);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<ErrorPageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openPendingKey, setOpenPendingKey] = useState<string | null>(null);
  const [pendingPanels, setPendingPanels] = useState<Record<string, PendingPanelState>>({});

  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const response = await apiRequest(session, "/v1/sources");
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isRecord(payload) || !Array.isArray(payload.sources)) throw new Error("The source list response was not recognized");
      setSources(payload.sources.filter((source): source is SourceOption =>
        isRecord(source) && typeof source.id === "string" && typeof source.host === "string",
      ));
    } catch (caught) {
      setSourcesError(caught instanceof Error ? caught.message : "Source options could not be loaded");
    }
  }, [session]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const currentCursor = cursorHistory[pageIndex] ?? null;
  const loadErrors = useCallback(async (isActive: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(filters.limit));
      if (filters.sourceId !== "") params.set("source_id", filters.sourceId);
      if (currentCursor !== null) params.set("cursor", currentCursor);
      const response = await apiRequest(session, `/v1/errors?${params.toString()}`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isErrorPage(payload)) throw new Error("The error-group response was not recognized");
      if (isActive()) setPage(payload);
    } catch (caught) {
      if (isActive()) setLoadError(caught instanceof Error ? caught.message : "Error history could not be loaded");
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [currentCursor, filters, session]);

  useEffect(() => {
    let active = true;
    void loadErrors(() => active);
    return () => { active = false; };
  }, [loadErrors]);

  const changeDraft = (key: keyof ErrorFilters, value: string) => {
    setDraftFilters((current) => ({ ...current, [key]: key === "limit" ? Number(value) : value }));
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(draftFilters);
    setCursorHistory([null]);
    setPageIndex(0);
    setOpenPendingKey(null);
  };

  const goToNextPage = () => {
    if (page?.next_cursor === null || page?.next_cursor === undefined) return;
    const nextCursor = page.next_cursor;
    setCursorHistory((history) => [...history.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((index) => index + 1);
    setOpenPendingKey(null);
  };

  const goToPreviousPage = () => {
    if (pageIndex === 0) return;
    setPageIndex((index) => index - 1);
    setOpenPendingKey(null);
  };

  const loadPending = async (group: ErrorGroup, key: string, cursor: string | null, append: boolean) => {
    const prior = pendingPanels[key];
    setPendingPanels((current) => ({
      ...current,
      [key]: { loading: true, error: null, pending: prior?.pending ?? [], nextCursor: prior?.nextCursor ?? null },
    }));
    try {
      const params = new URLSearchParams();
      params.set("status", group.status);
      params.set("source_id", group.source_id);
      params.set("limit", "20");
      if (cursor !== null) params.set("cursor", cursor);
      const response = await apiRequest(session, `/v1/pending?${params.toString()}`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!isPendingPage(payload)) throw new Error("The pending-item response was not recognized");
      setPendingPanels((current) => {
        const previous = current[key];
        return {
          ...current,
          [key]: {
            loading: false,
            error: null,
            pending: append ? [...(previous?.pending ?? []), ...payload.pending] : payload.pending,
            nextCursor: payload.next_cursor,
          },
        };
      });
    } catch (caught) {
      setPendingPanels((current) => ({
        ...current,
        [key]: { loading: false, error: caught instanceof Error ? caught.message : "Matching pending items could not be loaded", pending: current[key]?.pending ?? [], nextCursor: current[key]?.nextCursor ?? null },
      }));
    }
  };

  const togglePending = (group: ErrorGroup) => {
    const key = groupKey(group);
    if (openPendingKey === key) {
      setOpenPendingKey(null);
      return;
    }
    setOpenPendingKey(key);
    if (pendingPanels[key] === undefined) void loadPending(group, key, null, false);
  };

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Operational signals</p>
        <h2>Errors</h2>
        <p>Run-level errors and pending-item errors are separate event sources. Messages are sanitized by the API; this screen offers read-only drill-down.</p>
      </header>

      <form className="form-card error-filters" onSubmit={applyFilters}>
        <h3>Filter error groups</h3>
        <div className="error-filter-grid">
          <label className="form-field" htmlFor="error-source-filter">
            Error source
            <select id="error-source-filter" value={draftFilters.sourceId} onChange={(event) => changeDraft("sourceId", event.currentTarget.value)}>
              <option value="">All sources</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.host} ({source.id})</option>)}
            </select>
          </label>
          <label className="form-field" htmlFor="error-page-size">
            Groups per page
            <select id="error-page-size" value={draftFilters.limit} onChange={(event) => changeDraft("limit", event.currentTarget.value)}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>
        {sourcesError !== null && <div className="error-source-error" role="alert"><p>Source options unavailable: {sourcesError}</p><button className="secondary-button" type="button" onClick={() => void loadSources()}>Retry sources</button></div>}
        <div className="error-filter-actions"><button type="submit">Apply filters</button></div>
      </form>

      <LoadingError loading={loading} error={loadError} onRetry={() => { void loadErrors(() => true); }}>
        {page !== null && page.errors.length === 0 ? (
          <section className="empty-state"><h3>No error groups to show</h3><p>There are no matching run or pending-item errors in the available history.</p></section>
        ) : (
          <>
            <section className="error-group-list" aria-label="Error groups">
              {(page?.errors ?? []).map((group) => {
                const key = groupKey(group);
                const panel = pendingPanels[key];
                const expanded = openPendingKey === key;
                return (
                  <article className="error-group-card" key={key}>
                    <header className="error-group-header">
                      <div><p className={`error-origin-label error-origin-label--${group.origin}`}>{group.origin === "run" ? "Run error group" : "Pending-item error group"}</p><h3><code>{group.code}</code></h3></div>
                      <StatusBadge status={group.status} />
                    </header>
                    <dl className="error-group-metadata">
                      <div><dt>Source ID</dt><dd>{group.source_id}</dd></div>
                      <div><dt>Events</dt><dd>{group.count}</dd></div>
                      <div><dt>First seen</dt><dd>{timeLabel(group.first_time)}</dd></div>
                      <div><dt>Last seen</dt><dd>{timeLabel(group.last_time)}</dd></div>
                    </dl>
                    {group.samples.length > 0 && <div className="error-samples"><h4>Recent samples</h4><ul>{group.samples.map((sample, index) => <li key={`${sample.time}-${index}`}><time dateTime={dateTimeValue(sample.time)}>{timeLabel(sample.time)}</time><p>{sample.message ?? "No message available."}</p></li>)}</ul></div>}
                    {canDrillDown(group) && <button className="secondary-button pending-drilldown-toggle" type="button" aria-expanded={expanded} onClick={() => togglePending(group)}>{expanded ? "Hide matching pending items" : "Show matching pending items"}</button>}
                    {group.origin === "pending" && !canDrillDown(group) && <p className="pending-drilldown-note">This status is not available in the safe pending-item list.</p>}
                    {expanded && canDrillDown(group) && (
                      <section className="pending-drilldown" aria-label={`Matching pending items for ${group.source_id}`}>
                        <h4>Matching pending items</h4>
                        <p className="pending-drilldown-note">Only the filtered, safe pending fields are shown. No retry, purge, or edit action is available.</p>
                        {panel?.loading && <p className="loading-message" role="status">Loading pending items…</p>}
                        {panel?.error !== null && panel?.error !== undefined && <div className="pending-drilldown-error" role="alert"><p>{panel.error}</p><button className="secondary-button" type="button" onClick={() => { void loadPending(group, key, null, false); }}>Retry list request</button></div>}
                        {panel !== undefined && !panel.loading && panel.error === null && panel.pending.length === 0 && <p className="empty-message">No matching pending items are currently visible.</p>}
                        {panel !== undefined && panel.pending.length > 0 && <ul className="pending-item-list">{panel.pending.map((item) => <li className="pending-item-card" key={item.id}>
                          <header><h5>{item.title ?? "Untitled item"}</h5><StatusBadge status={item.status} /></header>
                          <p className="source-id">ID: {item.id} · Source: {item.source_id} · Type: {item.item_type}</p>
                          <dl className="pending-item-metadata"><div><dt>Attempts</dt><dd>{item.attempts}</dd></div><div><dt>Next attempt</dt><dd>{timeLabel(item.next_attempt_at)}</dd></div><div><dt>Terminal expiry</dt><dd>{item.terminal_expires_at === null ? "Not scheduled" : timeLabel(item.terminal_expires_at)}</dd></div></dl>
                          {item.error_code !== null && <p className="run-error-code">Error code: <code>{item.error_code}</code></p>}
                          {item.error_message !== null && <p className="error-copy run-error-message">{item.error_message}</p>}
                        </li>)}</ul>}
                        {panel?.nextCursor !== null && panel?.nextCursor !== undefined && <button className="secondary-button pending-load-more" type="button" disabled={panel.loading} onClick={() => { void loadPending(group, key, panel.nextCursor, true); }}>Load more pending items</button>}
                      </section>
                    )}
                  </article>
                );
              })}
            </section>
            {page !== null && page.errors.length > 0 && (
              <nav className="error-pagination" aria-label="Error group pages">
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
