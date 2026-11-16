import { Hono } from "hono";
import type { Env } from "../env";

interface StatusRow {
  active_pending_count: number;
  disabled_pending_count: number;
  oldest_pending_at: number | null;
  observed_db_size: number;
  storage_state: "normal" | "storage_limit" | "read_only";
}

export const status = new Hono<{ Bindings: Env }>();

status.get("/v1/status", async (context) => {
  const now = Math.floor(Date.now() / 1000);
  const row = await context.env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN source.enabled = 1 AND pending.status IN ('pending', 'leased', 'retry_wait') THEN 1 ELSE 0 END), 0) AS active_pending_count,
      COALESCE(SUM(CASE WHEN source.enabled = 0 AND pending.status IN ('pending', 'leased', 'retry_wait') THEN 1 ELSE 0 END), 0) AS disabled_pending_count,
      MIN(CASE WHEN pending.status IN ('pending', 'leased', 'retry_wait') THEN pending.discovered_at END) AS oldest_pending_at,
      state.observed_db_size,
      state.storage_state
    FROM system_state AS state
    LEFT JOIN pending_items AS pending ON pending.source_id IS NOT NULL
    LEFT JOIN sources AS source ON source.id = pending.source_id
    WHERE state.singleton_id = 'global'
  `).first<StatusRow>();

  return context.json({
    pending: {
      active_count: Number(row?.active_pending_count ?? 0),
      disabled_count: Number(row?.disabled_pending_count ?? 0),
      oldest_age_seconds: row?.oldest_pending_at === null || row?.oldest_pending_at === undefined
        ? null
        : Math.max(0, now - Number(row.oldest_pending_at)),
    },
    storage: {
      observed_db_size: Number(row?.observed_db_size ?? 0),
      state: row?.storage_state ?? "normal",
    },
  });
});
