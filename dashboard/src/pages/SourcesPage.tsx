import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { LoadingError } from "../components/LoadingError";
import { StatusBadge } from "../components/StatusBadge";

const MIN_POLL_INTERVAL_SECONDS = 900;
const SELECTOR_SOURCE_KINDS = new Set(["article", "html_list"]);

interface SourceRecord {
  id: string;
  url: string;
  host: string;
  kind: string;
  poll_interval_sec: number;
  selectors: Record<string, string> | null;
  enabled: boolean;
  next_fetch_at: number;
  consecutive_errors: number;
  last_status: string | null;
  last_fetched_at: number | null;
  created_at: number;
  updated_at: number;
  pending_count: number;
  oldest_pending_at: number | null;
}

interface SourcesPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
  onNavigate?: (path: string) => void;
}

function apiMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return `Source request failed (HTTP ${status})`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function formatInterval(seconds: number): string {
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1_000));
}

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return "Age unavailable";
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - timestamp);
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function isOverdue(source: SourceRecord, now = Math.floor(Date.now() / 1_000)): boolean {
  return source.enabled && source.next_fetch_at <= now;
}

function parseSelectors(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Selectors must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Selectors must be a JSON object");
  }
  return parsed as Record<string, string>;
}

export function SourcesPage({ session, onNavigate }: SourcesPageProps) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kind, setKind] = useState("feed");
  const [urlDraft, setUrlDraft] = useState("");
  const [intervalDraft, setIntervalDraft] = useState("7200");
  const [selectorsDraft, setSelectorsDraft] = useState("");

  const loadSources = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiRequest(session, "/v1/sources");
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (typeof payload !== "object" || payload === null || !("sources" in payload) || !Array.isArray(payload.sources)) {
        throw new Error("The source list response was not recognized");
      }
      setSources(payload.sources as SourceRecord[]);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Sources could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const activeFilter = new URLSearchParams(window.location.search).get("filter");
  const enabledFilter = new URLSearchParams(window.location.search).get("enabled");
  const visibleSources = sources.filter((source) => {
    if (enabledFilter === "disabled" && source.enabled) return false;
    if (enabledFilter === "enabled" && !source.enabled) return false;
    if (activeFilter === "overdue") return isOverdue(source);
    if (activeFilter === "backlog") return source.pending_count > 0;
    return true;
  });

  const navigate = (path: string) => {
    if (onNavigate !== undefined) onNavigate(path);
    else window.history.pushState(null, "", path);
  };

  const clearAddForm = () => {
    setKind("feed");
    setUrlDraft("");
    setIntervalDraft("7200");
    setSelectorsDraft("");
    setFormError(null);
    setShowAddForm(false);
  };

  const requestMutation = async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<SourceRecord> => {
    const response = await apiRequest(session, path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(apiMessage(payload, response.status));
    if (typeof payload !== "object" || payload === null || !("source" in payload)) {
      throw new Error("The source update response was not recognized");
    }
    return (payload as { source: SourceRecord }).source;
  };

  const createSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const interval = Number(intervalDraft);
    if (!Number.isSafeInteger(interval) || interval < MIN_POLL_INTERVAL_SECONDS) {
      setFormError(`Poll interval must be an integer of at least ${MIN_POLL_INTERVAL_SECONDS} seconds`);
      return;
    }
    const body: Record<string, unknown> = { kind, url: urlDraft, poll_interval_sec: interval };
    try {
      if (SELECTOR_SOURCE_KINDS.has(kind)) body.selectors = parseSelectors(selectorsDraft);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Selectors are invalid");
      return;
    }
    setBusy(true);
    try {
      const source = await requestMutation("/v1/sources", "POST", body);
      setSources((current) => [...current, source]);
      clearAddForm();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Source could not be created");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (source: SourceRecord) => {
    setEditingId(source.id);
    setIntervalDraft(String(source.poll_interval_sec));
    setSelectorsDraft(source.selectors === null ? "" : JSON.stringify(source.selectors, null, 2));
    setFormError(null);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>, source: SourceRecord) => {
    event.preventDefault();
    setFormError(null);
    const interval = Number(intervalDraft);
    if (!Number.isSafeInteger(interval) || interval < MIN_POLL_INTERVAL_SECONDS) {
      setFormError(`Poll interval must be an integer of at least ${MIN_POLL_INTERVAL_SECONDS} seconds`);
      return;
    }
    const body: Record<string, unknown> = { poll_interval_sec: interval };
    try {
      if (SELECTOR_SOURCE_KINDS.has(source.kind)) body.selectors = parseSelectors(selectorsDraft);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Selectors are invalid");
      return;
    }
    setBusy(true);
    try {
      const updated = await requestMutation(`/v1/sources/${encodeURIComponent(source.id)}`, "PATCH", body);
      setSources((current) => current.map((entry) => entry.id === source.id ? updated : entry));
      setEditingId(null);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Source could not be updated");
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = async (source: SourceRecord) => {
    setFormError(null);
    setBusy(true);
    try {
      const updated = await requestMutation(`/v1/sources/${encodeURIComponent(source.id)}`, "PATCH", { enabled: !source.enabled });
      setSources((current) => current.map((entry) => entry.id === source.id ? updated : entry));
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Source state could not be changed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Configuration and activity</p>
        <h2>Sources</h2>
        <p>Manage source polling and selectors. Source identity is shown by host and ID; full URLs and query parameters are not shown.</p>
      </header>

      <div className="sources-toolbar">
        <p>{sources.length} {sources.length === 1 ? "source" : "sources"} configured</p>
        <button type="button" onClick={() => { setShowAddForm((open) => !open); setEditingId(null); setFormError(null); }}>
          {showAddForm ? "Close add form" : "Add source"}
        </button>
      </div>

      {formError !== null && <p className="form-error" role="alert">{formError}</p>}

      {showAddForm && (
        <form className="form-card source-form" onSubmit={(event) => void createSource(event)}>
          <h3>Add source</h3>
          <div className="source-form-grid">
            <label className="form-field" htmlFor="new-source-kind">
              Source kind
              <select id="new-source-kind" value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
                <option value="feed">Feed</option>
                <option value="sitemap">Sitemap</option>
                <option value="article">Article page</option>
                <option value="html_list">HTML list</option>
              </select>
            </label>
            <label className="form-field" htmlFor="new-source-url">
              Source URL
              <input id="new-source-url" type="url" autoComplete="off" required value={urlDraft} onChange={(event) => setUrlDraft(event.currentTarget.value)} />
            </label>
            <label className="form-field" htmlFor="new-source-interval">
              Poll interval (seconds)
              <input id="new-source-interval" type="number" min={MIN_POLL_INTERVAL_SECONDS} step={1} required value={intervalDraft} onChange={(event) => setIntervalDraft(event.currentTarget.value)} />
            </label>
            {SELECTOR_SOURCE_KINDS.has(kind) && (
              <label className="form-field form-field--wide" htmlFor="new-source-selectors">
                Selectors JSON
                <textarea id="new-source-selectors" rows={6} spellCheck={false} value={selectorsDraft} onChange={(event) => setSelectorsDraft(event.currentTarget.value)} placeholder={'{ "title": "h1", "body": "article" }'} />
              </label>
            )}
          </div>
          <p className="form-note">For article and HTML-list sources, provide selectors as JSON. The URL is used for the request but is not displayed in the source list.</p>
          <button type="submit" disabled={busy}>Create source</button>
        </form>
      )}

      <p className="status-explanation">A disabled source pauses fetching but keeps its existing backlog. Blocked and storage-limit statuses are not empty feeds. Explicit errors such as network_error remain visible as statuses rather than being presented as an empty feed.</p>

      <LoadingError loading={loading} error={loadError} onRetry={() => void loadSources()}>
        {sources.length === 0 ? (
          <section className="empty-state">
            <h3>No sources configured yet</h3>
            <p>Add a feed or page source to begin collecting content.</p>
          </section>
        ) : visibleSources.length === 0 ? (
          <section className="empty-state">
            <h3>No sources match this filter</h3>
            <p>There are no sources that match the selected status and backlog filters.</p>
            <a href="/sources" onClick={(event) => { event.preventDefault(); navigate("/sources"); }}>Clear filter</a>
          </section>
        ) : (
          <section className="source-list" aria-label="Configured sources">
            {visibleSources.map((source) => {
              const overdue = isOverdue(source);
              return (
                <article className="source-card" key={source.id}>
                  <header className="source-card-header">
                    <div>
                      <h3>{source.host}</h3>
                      <p className="source-id">ID: {source.id}</p>
                    </div>
                    <div className="source-statuses">
                      <StatusBadge status={source.enabled ? "enabled" : "disabled"} />
                      <StatusBadge status={source.last_status} />
                    </div>
                  </header>
                  <div className="source-meta">
                    <p><span>Kind</span><strong>{source.kind}</strong></p>
                    <p><span>Enabled</span><strong>{source.enabled ? "Yes" : "No"}</strong></p>
                    <p><span>Poll interval</span><strong>{formatInterval(source.poll_interval_sec)}</strong></p>
                    <p><span>Last fetch</span><strong>{formatTimestamp(source.last_fetched_at)}</strong></p>
                    <p><span>Next fetch</span><strong>{formatTimestamp(source.next_fetch_at)}</strong>{overdue && <span className="overdue-label">Overdue</span>}</p>
                    <p><span>Consecutive errors</span><strong>{source.consecutive_errors}</strong></p>
                    <p><span>Backlog</span><strong>{source.pending_count} {source.pending_count === 1 ? "item" : "items"}</strong></p>
                    <p><span>Oldest backlog item</span><strong>{formatAge(source.oldest_pending_at)}</strong></p>
                  </div>

                  {source.last_status === "disabled_source" && <p className="status-note">Disabled source pauses fetching; its existing backlog is retained.</p>}
                  {(source.last_status === "blocked" || source.last_status === "storage_limit") && <p className="status-note">This explicit status is not an empty feed; inspect the status before changing the source.</p>}
                  {source.last_status !== null && !["disabled_source", "blocked", "storage_limit", "succeeded", "partial", "failed", "not_modified"].includes(source.last_status) && (
                    <p className="status-note">This explicit status is not an empty feed.</p>
                  )}

                  <div className="source-actions">
                    <button className="secondary-button" type="button" disabled={busy} aria-label={`Edit settings for ${source.host}`} onClick={() => beginEdit(source)}>Edit settings</button>
                    <button className="secondary-button" type="button" disabled={busy} aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.host}`} onClick={() => void toggleSource(source)}>
                      {source.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>

                  {editingId === source.id && (
                    <form className="form-card source-form" onSubmit={(event) => void saveEdit(event, source)}>
                      <h4>Edit source settings</h4>
                      <label className="form-field" htmlFor={`edit-interval-${source.id}`}>
                        Poll interval (seconds)
                        <input id={`edit-interval-${source.id}`} type="number" min={MIN_POLL_INTERVAL_SECONDS} step={1} required value={intervalDraft} onChange={(event) => setIntervalDraft(event.currentTarget.value)} />
                      </label>
                      {SELECTOR_SOURCE_KINDS.has(source.kind) && (
                        <label className="form-field" htmlFor={`edit-selectors-${source.id}`}>
                          Selectors JSON
                          <textarea id={`edit-selectors-${source.id}`} rows={6} spellCheck={false} value={selectorsDraft} onChange={(event) => setSelectorsDraft(event.currentTarget.value)} />
                        </label>
                      )}
                      <div className="source-actions">
                        <button type="submit" disabled={busy}>Save changes</button>
                        <button className="secondary-button" type="button" onClick={() => { setEditingId(null); setFormError(null); }}>Cancel</button>
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </LoadingError>
    </div>
  );
}
