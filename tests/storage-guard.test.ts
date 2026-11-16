import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { checkWriteGate, completeWriteReservation } from "../src/ingest/storage-guard";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

interface StorageStateRow {
  observed_db_size: number;
  reserved_db_bytes: number;
  storage_state: "normal" | "storage_limit" | "read_only";
}

const testEnv = env as unknown as TestBindings;

function withMeasuredSize(db: D1Database, measuredSize: number, batchSize = measuredSize): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          return results.map((result) => ({ ...result, meta: { ...result.meta, size_after: batchSize } }));
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              if (statementProperty === "run" && typeof value === "function") {
                return async <T = unknown>(): Promise<D1Result<T>> => {
                  const result = await statementTarget.run<T>();
                  if (query.includes("write_gate_probe")) {
                    return { ...result, meta: { ...result.meta, size_after: measuredSize } } as D1Result<T>;
                  }
                  return result;
                };
              }
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("shared D1 storage gate", () => {
  it("accounts_for_existing_reservations_before_allowing_another_pending_writer", async () => {
    const measuredDb = withMeasuredSize(testEnv.DB, 270 * 1024 * 1024);
    const estimate = 5 * 1024 * 1024;

    const first = await checkWriteGate(measuredDb, "pending", estimate, "first-reservation", 100);
    const second = await checkWriteGate(measuredDb, "pending", estimate, "second-reservation", 101);
    const state = await testEnv.DB.prepare("SELECT observed_db_size, reserved_db_bytes, storage_state FROM system_state WHERE singleton_id = 'global'")
      .first<StorageStateRow>();
    const reservations = await testEnv.DB.prepare("SELECT reservation_id FROM storage_write_reservations ORDER BY reservation_id")
      .all<{ reservation_id: string }>();

    expect(first).toMatchObject({ id: "first-reservation", measuredSize: 270 * 1024 * 1024, estimatedBytes: estimate });
    expect(second).toBe("storage_limit");
    expect(state).toMatchObject({
      observed_db_size: 270 * 1024 * 1024,
      reserved_db_bytes: estimate,
      storage_state: "storage_limit",
    });
    expect(reservations.results.map((row) => row.reservation_id)).toEqual(["first-reservation"]);

    if (typeof first !== "string") await completeWriteReservation(testEnv.DB, first.id, 270 * 1024 * 1024, 102);
    const released = await testEnv.DB.prepare("SELECT observed_db_size, reserved_db_bytes, storage_state FROM system_state WHERE singleton_id = 'global'")
      .first<StorageStateRow>();
    expect(released).toMatchObject({ reserved_db_bytes: 0, storage_state: "normal" });
  });

  it("persists_the_physical_size_reported_after_a_denied_reservation_batch", async () => {
    const measuredDb = withMeasuredSize(testEnv.DB, 278 * 1024 * 1024, 279 * 1024 * 1024);

    const result = await checkWriteGate(measuredDb, "pending", 2 * 1024 * 1024, "denied-reservation", 100);
    const state = await testEnv.DB.prepare("SELECT observed_db_size, reserved_db_bytes, storage_state FROM system_state WHERE singleton_id = 'global'")
      .first<StorageStateRow>();

    expect(result).toBe("storage_limit");
    expect(state).toMatchObject({
      observed_db_size: 279 * 1024 * 1024,
      reserved_db_bytes: 0,
      storage_state: "storage_limit",
    });
  });
});
