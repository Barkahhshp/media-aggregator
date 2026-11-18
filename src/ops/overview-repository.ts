import type { RunStatus } from "../runs/repository";
import { RUN_STATUSES, sanitizeErrorCode, sanitizeErrorMessage } from "../runs/repository";
import { D1_STORAGE_HARD_CAP_BYTES, D1_STORAGE_STOP_BYTES } from "../ingest/storage-guard";

const RUN_WINDOW_SECONDS = 24 * 60 * 60;
const PENDING_STATUSES = ["pending", "leased", "retry_wait", "blocked", "failed"] as const;
const ACTIVE_PENDING_STATUSES = ["pending", "leased", "retry_wait"] as const;

type PendingStatus = typeof PENDING_STATUSES[number];

interface StorageRow {
  observed_db_size: number;
  storage_state: "normal" | "storage_limit" | "read_only";
}

interface SourceSummaryRow {
  enabled_count: number;
  disabled_count: number;
  overdue_count: number;
}

interface PendingGroupRow {
  enabled: number;
  status: string;
  item_count: number;
  oldest_active_at: number | null;
}

interface RunCountRow {
  status: string;
  run_count: number;
}

interface LatestRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
}

export interface Overview {
  storage: {
    state: StorageRow["storage_state"];
    observed_db_size: number;
    warning_threshold_bytes: number;
    hard_stop_threshold_bytes: number;
  };
  pending: {
    active_count: number;
    disabled_count: number;
    oldest_age_seconds: number | null;
    by_status: {
      active: Record<PendingStatus, number>;
      disabled: Record<PendingStatus, number>;
    };
  };
  sources: {
    enabled_count: number;
    disabled_count: number;
    overdue_count: number;
  };
  runs_24h: Record<RunStatus, number>;
  latest_run: null | (LatestRunRow & { error_code: string | null; error_message: string | null; duration_seconds: number });
}

function emptyPendingStatusCounts(): Record<PendingStatus, number> {
  return { pending: 0, leased: 0, retry_wait: 0, blocked: 0, failed: 0 };
}

function emptyRunCounts(): Record<RunStatus, number> {
  return Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
}

const STORAGE_QUERY = `
  SELECT observed_db_size, storage_state
  FROM system_state
  WHERE singleton_id = 'global'
`;

const SOURCE_SUMMARY_QUERY = `
  SELECT
    COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_count,
    COALESCE(SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END), 0) AS disabled_count,
    COALESCE(SUM(CASE WHEN enabled = 1 AND next_fetch_at <= ? THEN 1 ELSE 0 END), 0) AS overdue_count
  FROM sources INDEXED BY idx_sources_due
`;

const PENDING_SUMMARY_QUERY = `
  SELECT
    source.enabled AS enabled,
    pending.status AS status,
    COUNT(*) AS item_count,
    MIN(CASE
      WHEN source.enabled = 1 AND pending.status IN ('pending', 'leased', 'retry_wait')
      THEN pending.discovered_at
    END) AS oldest_active_at
  FROM pending_items AS pending INDEXED BY idx_pending_source_status
  JOIN sources AS source ON source.id = pending.source_id
  GROUP BY source.enabled, pending.status
`;

const RUNS_24H_QUERY = `
  SELECT status, COUNT(*) AS run_count
  FROM fetch_runs INDEXED BY idx_fetch_runs_started
  WHERE started_at >= ? AND started_at <= ?
  GROUP BY status
`;

const LATEST_RUN_QUERY = `
  SELECT id, started_at, finished_at, status, http_status, discovered_count, stored_count, error_code, error_message
  FROM fetch_runs INDEXED BY idx_fetch_runs_started
  WHERE started_at <= ?
  ORDER BY started_at DESC, id DESC
  LIMIT 1
`;

function isPendingStatus(status: string): status is PendingStatus {
  return (PENDING_STATUSES as readonly string[]).includes(status);
}

function isActivePendingStatus(status: string): boolean {
  return (ACTIVE_PENDING_STATUSES as readonly string[]).includes(status);
}

export async function getOverview(db: D1Database, now: number): Promise<Overview> {
  const [storageRow, sourceRow, pendingResult, runCountResult, latestRunRow] = await Promise.all([
    db.prepare(STORAGE_QUERY).first<StorageRow>(),
    db.prepare(SOURCE_SUMMARY_QUERY).bind(now).first<SourceSummaryRow>(),
    db.prepare(PENDING_SUMMARY_QUERY).all<PendingGroupRow>(),
    db.prepare(RUNS_24H_QUERY).bind(now - RUN_WINDOW_SECONDS, now).all<RunCountRow>(),
    db.prepare(LATEST_RUN_QUERY).bind(now).first<LatestRunRow>(),
  ]);

  const activeByStatus = emptyPendingStatusCounts();
  const disabledByStatus = emptyPendingStatusCounts();
  let oldestActiveAt: number | null = null;
  for (const row of pendingResult.results) {
    if (!isPendingStatus(row.status)) continue;
    const statusCounts = row.enabled === 1 ? activeByStatus : disabledByStatus;
    statusCounts[row.status] = Number(row.item_count);
    if (row.enabled === 1 && isActivePendingStatus(row.status) && row.oldest_active_at !== null) {
      const oldest = Number(row.oldest_active_at);
      oldestActiveAt = oldestActiveAt === null ? oldest : Math.min(oldestActiveAt, oldest);
    }
  }

  const runCounts = emptyRunCounts();
  for (const row of runCountResult.results) {
    if ((RUN_STATUSES as readonly string[]).includes(row.status)) {
      runCounts[row.status as RunStatus] = Number(row.run_count);
    }
  }

  const latestRun = latestRunRow === null ? null : {
    ...latestRunRow,
    error_code: sanitizeErrorCode(latestRunRow.error_code),
    error_message: sanitizeErrorMessage(latestRunRow.error_message),
    duration_seconds: Math.max(0, (latestRunRow.finished_at ?? now) - latestRunRow.started_at),
  };

  const activeCount = ACTIVE_PENDING_STATUSES.reduce((sum, status) => sum + activeByStatus[status], 0);
  const disabledCount = ACTIVE_PENDING_STATUSES.reduce((sum, status) => sum + disabledByStatus[status], 0);

  return {
    storage: {
      state: storageRow?.storage_state ?? "normal",
      observed_db_size: Number(storageRow?.observed_db_size ?? 0),
      warning_threshold_bytes: D1_STORAGE_STOP_BYTES,
      hard_stop_threshold_bytes: D1_STORAGE_HARD_CAP_BYTES,
    },
    pending: {
      active_count: activeCount,
      disabled_count: disabledCount,
      oldest_age_seconds: oldestActiveAt === null ? null : Math.max(0, now - oldestActiveAt),
      by_status: { active: activeByStatus, disabled: disabledByStatus },
    },
    sources: {
      enabled_count: Number(sourceRow?.enabled_count ?? 0),
      disabled_count: Number(sourceRow?.disabled_count ?? 0),
      overdue_count: Number(sourceRow?.overdue_count ?? 0),
    },
    runs_24h: runCounts,
    latest_run: latestRun,
  };
}
