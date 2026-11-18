import { useCallback, useEffect, useState } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { LoadingError } from "../components/LoadingError";
import { StatusBadge } from "../components/StatusBadge";

interface OverviewResponse {
  storage: {
    state: string;
    observed_db_size: number;
    warning_threshold_bytes: number;
    hard_stop_threshold_bytes: number;
  };
  pending: {
    active_count: number;
    disabled_count: number;
    oldest_age_seconds: number | null;
    by_status: {
      active: Record<string, number>;
      disabled: Record<string, number>;
    };
  };
  sources: {
    enabled_count: number;
    disabled_count: number;
    overdue_count: number;
  };
  runs_24h: Record<string, number>;
  latest_run: null | {
    id: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    http_status: number | null;
    discovered_count: number;
    stored_count: number;
    error_code: string | null;
    error_message: string | null;
    duration_seconds: number;
  };
}

interface OverviewPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
  onNavigate: (path: string) => void;
}

function apiMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return `Overview could not be loaded (HTTP ${status})`;
}

async function readOverview(session: OverviewPageProps["session"]): Promise<OverviewResponse> {
  const response = await apiRequest(session, "/v1/overview");
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(apiMessage(payload, response.status));
  return payload as OverviewResponse;
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function formatCount(count: number, label: string): string {
  return `${count} ${label} ${count === 1 ? "item" : "items"}`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "Age unavailable";
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes === 0
      ? `${hours} ${hours === 1 ? "hour" : "hours"}`
      : `${hours} ${hours === 1 ? "hour" : "hours"}, ${minutes} min`;
  }
  const days = Math.floor(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1_000));
}

function FilterLink({ href, children, onNavigate }: { href: string; children: string; onNavigate: (path: string) => void }) {
  return (
    <a href={href} onClick={(event) => { event.preventDefault(); onNavigate(href); }}>
      {children}
    </a>
  );
}

export function OverviewPage({ session, onNavigate }: OverviewPageProps) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await readOverview(session));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Overview could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  if (overview === null) {
    return <LoadingError loading={loading} error={error} onRetry={() => void loadOverview()}>{null}</LoadingError>;
  }

  const hardStopReached = overview.storage.state === "storage_limit"
    || overview.storage.observed_db_size >= overview.storage.hard_stop_threshold_bytes;
  const warningReached = !hardStopReached && (
    overview.storage.observed_db_size >= overview.storage.warning_threshold_bytes
    || overview.storage.state === "read_only"
  );
  const storageLabel = hardStopReached
    ? "Application hard stop reached"
    : warningReached
      ? "Warning threshold reached"
      : "Storage below warning threshold";
  const sizePercent = overview.storage.hard_stop_threshold_bytes > 0
    ? Math.min(100, Math.round(overview.storage.observed_db_size / overview.storage.hard_stop_threshold_bytes * 100))
    : 0;
  const runStatuses = ["succeeded", "partial", "failed", "blocked", "storage_limit", "running"];

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Operations</p>
        <h2>Overview</h2>
        <p>Current storage, backlog, sources, and fetch activity. These counts are operational summaries, not an overall health or SLA score.</p>
      </header>

      <LoadingError loading={loading} error={error} onRetry={() => void loadOverview()}>
        <section className="overview-grid" aria-label="Operational summary">
          <article className={`metric-card ${hardStopReached ? "metric-card--attention" : warningReached ? "metric-card--caution" : ""}`}>
            <p className="card-label">Database storage</p>
            <h3>{formatMiB(overview.storage.observed_db_size)}</h3>
            <p className="metric-emphasis">{storageLabel}</p>
            <p>Warning at {formatMiB(overview.storage.warning_threshold_bytes)} · hard stop at {formatMiB(overview.storage.hard_stop_threshold_bytes)}</p>
            <progress aria-label="Storage relative to hard stop" max={100} value={sizePercent}>{sizePercent}%</progress>
            <p>{sizePercent}% of the application hard-stop size</p>
          </article>

          <article className="metric-card">
            <p className="card-label">Active backlog</p>
            <h3>{overview.pending.active_count}</h3>
            <p>{formatCount(overview.pending.active_count, "active backlog")}</p>
            <p>{formatCount(overview.pending.disabled_count, "disabled-source backlog")}</p>
            {overview.pending.active_count === 0 && overview.pending.disabled_count === 0 && <p className="empty-message">No pending backlog</p>}
            <p>{overview.pending.oldest_age_seconds === null ? "No active backlog age" : `Oldest active item: ${formatAge(overview.pending.oldest_age_seconds)} ago`}</p>
            {(overview.pending.active_count > 0 || overview.pending.disabled_count > 0) && (
              <div className="problem-links">
                {overview.pending.active_count > 0 && <FilterLink href="/sources?filter=backlog" onNavigate={onNavigate}>View backlog sources</FilterLink>}
                {overview.pending.disabled_count > 0 && <FilterLink href="/sources?filter=backlog&enabled=disabled" onNavigate={onNavigate}>View disabled-backlog sources</FilterLink>}
              </div>
            )}
          </article>

          <article className="metric-card">
            <p className="card-label">Sources</p>
            <h3>{overview.sources.enabled_count + overview.sources.disabled_count}</h3>
            <p>{overview.sources.enabled_count} enabled · {overview.sources.disabled_count} disabled</p>
            <p>{overview.sources.overdue_count === 0 ? "No overdue sources" : `${overview.sources.overdue_count} overdue ${overview.sources.overdue_count === 1 ? "source" : "sources"}`}</p>
            {overview.sources.enabled_count + overview.sources.disabled_count === 0
              ? <p>No sources configured yet</p>
              : overview.sources.overdue_count > 0 && (
                <div className="problem-links">
                  <FilterLink href="/sources?filter=overdue" onNavigate={onNavigate}>View overdue sources</FilterLink>
                </div>
              )}
          </article>

          <article className="metric-card latest-run-card">
            <p className="card-label">Latest run</p>
            {overview.latest_run === null ? (
              <p className="empty-message">No fetch runs recorded yet</p>
            ) : (
              <>
                <h3><StatusBadge status={overview.latest_run.status} /></h3>
                <p className="mono-text">{overview.latest_run.id}</p>
                <p>Started {formatTimestamp(overview.latest_run.started_at)} · {overview.latest_run.duration_seconds}s</p>
                <p>{overview.latest_run.stored_count} stored of {overview.latest_run.discovered_count} discovered</p>
                {overview.latest_run.error_message !== null && <p className="error-copy">{overview.latest_run.error_message}</p>}
              </>
            )}
          </article>
        </section>

        <section className="summary-section" aria-labelledby="runs-summary-title">
          <div className="section-heading">
            <div>
              <p className="card-label">Last 24 hours</p>
              <h3 id="runs-summary-title">Run status summary</h3>
            </div>
            <p>Run outcomes are separate from pending-item errors.</p>
          </div>
          {Object.values(overview.runs_24h).every((count) => count === 0) ? (
            <p className="empty-message">No runs in the last 24 hours</p>
          ) : (
            <div className="run-summary-grid">
              {runStatuses.map((status) => {
                const count = overview.runs_24h[status] ?? 0;
                return (
                  <article className="run-summary-card" key={status}>
                    <StatusBadge status={status} />
                    <p>{count} {status === "storage_limit" ? "storage limit" : status}</p>
                  </article>
                );
              })}
            </div>
          )}
          {overview.pending.by_status.active.blocked > 0 && (
            <p className="problem-callout">
              {overview.pending.by_status.active.blocked} active pending items are blocked. They are not empty-feed results.
            </p>
          )}
        </section>
      </LoadingError>
    </div>
  );
}
