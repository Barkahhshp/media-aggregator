const OPERATOR_ACTION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Delete only operator actions strictly older than the 90-day retention window. */
export async function purgeExpiredOperatorActions(db: D1Database, now: number): Promise<number> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new RangeError("now must be a positive integer epoch timestamp");
  const result = await db.prepare(`
    DELETE FROM operator_actions
    WHERE created_at < ?
      AND created_at < unixepoch() - ?
  `).bind(now - OPERATOR_ACTION_RETENTION_SECONDS, OPERATOR_ACTION_RETENTION_SECONDS).run();
  return result.meta.changes;
}
