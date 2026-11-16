# Final Whole-Project Review Fix Report

Base commit: `00b9be9ca7ef4f85c71d09d412e441858cd48194` (`feature/media-aggregator-mvp`).

Scope: all findings from the final whole-branch review, in one local-only fix wave. No deployment and no Cloudflare account resources were created.

## Findings addressed

1. `content_too_large` export/restore now preserves the existing hash of the fetched oversized body while accepting the explicitly empty stored/exported body only when `status = content_too_large` and the hash is valid SHA-256 hex. Retained body text is still rehashed normally. This keeps the existing storage semantics and makes the backup restorable without fabricating the discarded content.
2. Authenticated `/v1/*` requests are rate-limited per service token with a Workers Rate Limiting API binding (120 requests / 60 seconds). Production identity comes from the Access service-token `common_name`; local bearer-token identity is also supported. Only a SHA-256 digest is passed as the rate-limit key; no raw token identity or secret is logged or stored. Wrangler now declares D1 and the limiter in both base and production environments because environment bindings are not inherited.
3. Added protected `GET /v1/status` for active/disabled pending counts, oldest backlog age, and observed D1 size/storage state. `GET /v1/sources` now includes `pending_count` and `oldest_pending_at` per source.
4. Disabled-source pending rows remain retained and visible, but are excluded from claims/fetches. Scheduler run/source state shows `disabled_source`, including non-due `retry_wait` rows. Re-enabling a source clears the stale disabled marker.
5. Added a local Workers-runtime fixture that parses a representative 100-item feed and persists all 100 items through ten bounded 10-row pending batches. The report below separates synchronous parse timing from D1 wall time.
6. `PATCH {"poll_interval_sec": null}` is rejected; valid `source_id`, inclusive `from`, exclusive `to`, `q`, and cursor filtering are covered together at the `/v1/articles` integration boundary.
7. The export example now uses `umask 077`, a private temporary file, and an atomic hard-link publication that refuses to replace an existing same-timestamp destination. A disposable shell probe confirmed mode `600`, failed exclusive link against an existing file, and preserved the existing contents.
8. Export session creation passes the shared D1 storage gate. Session creation removes completed/expired/stale rows within the same bounded transaction; `endExport` deletes the completed session while releasing the lock, and expiry removes the stale active session/lock. Tests verify cleanup does not delete a current active session or release its lock.
9. `npm run lint` now runs `eslint .`. Fixed all five previously reported full-project lint findings in `src/articles/repository.ts`, `tests/articles-repository.test.ts`, `tests/discovery.test.ts`, and `tests/storage-physical-fill.test.ts`.

## TDD evidence

### Oversized article restore

Regression test: `tests/exports-restore.test.ts` writes a real oversized article through the article writer, exports it, and restores into the empty local D1 database.

RED command, run against the base restore parser:

```text
npm test -- tests/exports-restore.test.ts -t 'round_trips_content_too_large_articles_with_hash_semantics_matching_stored_text'
```

Observed: `Test Files 1 failed (1); Tests 1 failed | 3 skipped (4)`. Restore failed with `Article content hash mismatch for article_13532775008a7d948be59e861438f10f49ba73c6e34b4996b46484a5de939ab8` at `parseExportNdjson` because exported body was empty while the hash described the fetched oversized body.

GREEN command:

```text
npm test -- tests/exports-restore.test.ts
```

Observed: `Test Files 1 passed (1); Tests 4 passed (4)`, including the oversized row retaining its original hash and empty text after local restore.

### Service-token rate limit, operational status/backlog, disabled claims, null PATCH, and session cleanup

The initial combined RED was:

```text
npm test -- tests/article-store.test.ts tests/exports-restore.test.ts tests/pending-repository.test.ts tests/sources-api.test.ts tests/scheduler.test.ts tests/articles-api.test.ts tests/exports-api.test.ts -t 'records_content_over_500|round_trips_content_too_large|does_not_claim_pending_backlog_for_a_disabled_source|rejects_a_null_poll_interval|propagates_source_from_to_q_and_cursor_filters_together|rate_limits_each_authenticated_service_token_separately|exposes_per_source_pending_backlog_and_global_storage_status|keeps_disabled_source_backlog_without_claiming_or_fetching_it|purges_stale_export_sessions_without_removing_an_active_session_or_lock'
```

Observed: `Test Files 5 failed | 2 passed (7); Tests 7 failed | 2 passed | 85 skipped (94)`. Expected REDs included stale session rows remaining (`expected 3 to be 1`), disabled pending work being claimed and fetched, rate limiting returning 200 instead of 429, missing backlog fields, and null poll interval returning 200 instead of 400. The combined command also confirmed the existing combined article-filter regression passed; no article-query implementation change was needed.

Focused RED for the absent status endpoint, using the base app module:

```text
npm test -- tests/sources-api.test.ts -t 'exposes_per_source_pending_backlog_and_global_storage_status'
```

Observed: `expected 404 to be 200`; `Test Files 1 failed (1); Tests 1 failed | 18 skipped (19)`.

Focused RED for export storage admission:

```text
npm test -- tests/exports-api.test.ts -t 'refuses_to_create_an_export_session_when_the_storage_gate_is_closed'
```

Observed on base repository implementation: `expected 201 to be 503`; `Test Files 1 failed (1); Tests 1 failed | 8 skipped (9)`.

Focused RED for a disabled source with a future retry deadline:

```text
npm test -- tests/scheduler.test.ts -t 'keeps_disabled_source_backlog_without_claiming_or_fetching_it'
```

Observed: no fetch was made, but the run returned `errorCode: pending_backlog` instead of `disabled_source`; `Test Files 1 failed (1); Tests 1 failed | 17 skipped (18)`. After changing status aggregation to include retained non-due disabled rows, the same command passed: `Test Files 1 passed (1); Tests 1 passed | 17 skipped (18)`.

Focused RED for clearing the disabled marker after re-enable:

```text
npm test -- tests/sources-api.test.ts -t 'clears_disabled_source_status_when_the_source_is_reenabled'
```

Observed: `enabled: true` still returned `last_status: disabled_source`; `Test Files 1 failed (1); Tests 1 failed | 18 skipped (19)`. After updating the source repository status transition, the same command passed: `Test Files 1 passed (1); Tests 1 passed | 18 skipped (19)`.

Focused RED for deleting completed session rows when releasing the export lock:

```text
npm test -- tests/exports-api.test.ts -t 'locks_ingestion_and_all_source_mutations_until_endExport_releases_the_lock'
```

Observed on the base repository: expected no session row but received `{ id: ... }`; `Test Files 1 failed (1); Tests 1 failed | 8 skipped (9)`. After `endExport` deleted the row in the same batch as lock release, the same command passed: `Test Files 1 passed (1); Tests 1 passed | 8 skipped (9)`.

Focused GREEN suite after fixes:

```text
npm test -- tests/exports-restore.test.ts tests/exports-api.test.ts tests/scheduler.test.ts tests/sources-api.test.ts tests/pending-repository.test.ts tests/articles-api.test.ts tests/throughput-benchmark.test.ts
```

Observed: `Test Files 7 passed (7); Tests 91 passed (91)`.

### Local throughput measurement

The full test run’s Workers-runtime fixture output was:

```text
LOCAL_WORKER_INGEST_FIXTURE parse_median_ms=6.00 parse_max_ms=10.00 persist_elapsed_ms=344.00 median_plus_persist_ms=350.00 parsed=100 persisted=100 batch_size=10 batches=10
```

The 6 ms median / 10 ms maximum are synchronous parser elapsed-time measurements over 20 warmed local samples. The 344 ms persistence figure is local D1 wall time for 10 batches and is not billed CPU. Production CPU use against Workers Free’s 10 ms budget remains unverified because this task expressly did not deploy. The Cloudflare Rate Limiting API is approximate and location-local, not a strict global quota; the account operator must confirm `namespace_id` uniqueness before a later deployment.

## Final verification

Exact final verification chain:

```text
npm test
Test Files 23 passed (23)
Tests 217 passed (217)
LOCAL_D1_PHYSICAL_SIZE_AFTER=295211008; STOP_BYTES=293601280

npm run lint
Passed (exit 0; command is `eslint .`).

npm run typecheck
Passed (exit 0).

npm run build
Wrangler dry run passed; Total Upload: 298.51 KiB / gzip: 65.18 KiB; bindings include D1 and RATE_LIMITER (120 requests/60s); --dry-run exited.

npx wrangler deploy --dry-run --outdir /tmp/media-aggregator-production-dry-run --env production
Passed without binding-inheritance warnings; production dry run includes D1, RATE_LIMITER, and APP_ENV=production. No deploy occurred.

npm audit --omit=dev
found 0 vulnerabilities

npm audit
found 0 vulnerabilities

git diff --check
Passed.
```

The previously added 10,000-record export regression remains green: one cached count statement across 1,112 pages; measured `meta.rows_read` was 26,682 (below the 5,000,000 Free daily limit), with all 10,000 rows exported. Page caps and the 30-minute shared export lock remain intact.

No Cloudflare resource was created and nothing was deployed. Production Access enforcement, the real remote rate-limiter behavior, and billed Worker CPU remain unverified by design; Access must protect `/health` and `/v1/*` on the later custom hostname.
