export const D1_STORAGE_STOP_BYTES = 280 * 1024 * 1024;
export const D1_STORAGE_HARD_CAP_BYTES = 300 * 1024 * 1024;
export const WRITE_RESERVATION_TTL_SECONDS = 120;

export type WriteKind = "pending" | "article" | "source" | "run";

export interface WriteReservation {
  id: string;
  measuredSize: number;
  estimatedBytes: number;
}

function normalizeEstimate(estimatedBytes: number): number {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new RangeError("estimatedBytes must be a positive safe integer");
  }
  return estimatedBytes;
}

/**
 * Measure physical D1 size (including indexes/FTS), then reserve estimated
 * growth. Reservation and shared totals are updated in one serialized batch,
 * so concurrent gated writers cannot spend the same space.
 */
export async function checkWriteGate(
  db: D1Database,
  writeKind: WriteKind,
  estimatedBytes: number,
  reservationId: string = crypto.randomUUID(),
  now = Math.floor(Date.now() / 1000),
): Promise<WriteReservation | "storage_limit"> {
  const estimate = normalizeEstimate(estimatedBytes);

  const measured = await db.prepare(`
    SELECT /* write_gate_probe */ singleton_id
    FROM system_state
    WHERE singleton_id = 'global'
  `).run<{ singleton_id: string }>();
  const measuredSize = measured.meta.size_after;

  const results = await db.batch([
    db.prepare("DELETE FROM storage_write_reservations WHERE expires_at <= ?")
      .bind(now),
    db.prepare(`
      UPDATE system_state
      SET observed_db_size = MAX(observed_db_size, ?),
          reserved_db_bytes = (
            SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_write_reservations
          ),
          storage_state = CASE
            WHEN MAX(observed_db_size, ?) >= ? THEN 'read_only'
            WHEN storage_state = 'read_only' THEN 'read_only'
            WHEN MAX(observed_db_size, ?) + (
              SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_write_reservations
            ) + ? >= ? THEN 'storage_limit'
            ELSE 'normal'
          END,
          updated_at = ?
      WHERE singleton_id = 'global'
    `).bind(
      measuredSize,
      measuredSize,
      D1_STORAGE_HARD_CAP_BYTES,
      measuredSize,
      estimate,
      D1_STORAGE_STOP_BYTES,
      now,
    ),
    db.prepare(`
      INSERT INTO storage_write_reservations (reservation_id, write_kind, reserved_bytes, expires_at)
      SELECT ?, ?, ?, ?
      FROM system_state
      WHERE singleton_id = 'global'
        AND storage_state = 'normal'
        AND observed_db_size + reserved_db_bytes + ? < ?
        AND observed_db_size + reserved_db_bytes + ? < ?
      RETURNING reservation_id
    `).bind(
      reservationId,
      writeKind,
      estimate,
      now + WRITE_RESERVATION_TTL_SECONDS,
      estimate,
      D1_STORAGE_STOP_BYTES,
      estimate,
      D1_STORAGE_HARD_CAP_BYTES,
    ),
    db.prepare(`
      UPDATE system_state
      SET reserved_db_bytes = (
        SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_write_reservations
      ),
          updated_at = ?
      WHERE singleton_id = 'global'
    `).bind(now),
  ]);

  const insertedReservation = (results[2]?.results?.length ?? 0) > 0;
  const reservationBatchSize = results[3]?.meta.size_after ?? measuredSize;
  if (!insertedReservation) {
    await db.prepare(`
      UPDATE system_state
      SET observed_db_size = MAX(observed_db_size, ?),
          storage_state = CASE
            WHEN MAX(observed_db_size, ?) >= ? THEN 'read_only'
            WHEN storage_state = 'read_only' THEN 'read_only'
            ELSE 'storage_limit'
          END,
          updated_at = ?
      WHERE singleton_id = 'global'
    `).bind(
      reservationBatchSize,
      reservationBatchSize,
      D1_STORAGE_HARD_CAP_BYTES,
      now,
    ).run();
    return "storage_limit";
  }
  if (reservationBatchSize >= D1_STORAGE_STOP_BYTES) {
    await completeWriteReservation(db, reservationId, reservationBatchSize, now);
    return "storage_limit";
  }
  return { id: reservationId, measuredSize: reservationBatchSize, estimatedBytes: estimate };
}

/** Record a write's measured D1 size and release its reservation atomically. */
export async function completeWriteReservation(
  db: D1Database,
  reservationId: string,
  sizeAfter: number,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM storage_write_reservations WHERE reservation_id = ?")
      .bind(reservationId),
    db.prepare(`
      UPDATE system_state
      SET observed_db_size = MAX(observed_db_size, ?),
          reserved_db_bytes = (
            SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_write_reservations
          ),
          storage_state = CASE
            WHEN MAX(observed_db_size, ?) >= ? THEN 'read_only'
            WHEN storage_state = 'read_only' THEN 'read_only'
            WHEN MAX(observed_db_size, ?) + (
              SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_write_reservations
            ) >= ? THEN 'storage_limit'
            ELSE 'normal'
          END,
          updated_at = ?
      WHERE singleton_id = 'global'
    `).bind(
      sizeAfter,
      sizeAfter,
      D1_STORAGE_HARD_CAP_BYTES,
      sizeAfter,
      D1_STORAGE_STOP_BYTES,
      now,
    ),
  ]);
}
