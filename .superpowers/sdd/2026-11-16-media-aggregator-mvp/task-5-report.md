# Task 5 — Scheduled ingestion, article storage, and D1 write gate

## Status

Implemented and committed on `feature/media-aggregator-mvp` as `feat: ingest feeds and store bounded full text`, based on `62a002c366bdad51809f7471488925d1f09fcfe6`.

## What changed

- Added the scheduled Worker pipeline and minute Cron entry. It checks the export lock before work, reclaims expired export locks, acquires one global lease, purges expired terminal pending rows and 30-day fetch-run records, then prioritizes eligible pending items/backlog before one due source. It fetches at most one source/sitemap and at most two articles per invocation.
- Wrapped all D1 statements and `db.batch()` calls in one invocation-wide counter, sharing the 50 subrequest budget with outbound fetch hops. Five D1 calls are reserved for final storage-state read, run result, lease release, physical-size probe, and reservation cleanup.
- Reused the Task 4 serialized storage reservations for run/source/article writes and pending claim/failure writes. Post-write D1 size checks stop work at 280 MiB; the 300 MiB measured hard cap enters `read_only`. Article transactions retain the peak `meta.size_after` from every statement, so a later deletion cannot mask an earlier threshold crossing.
- Added bounded article normalization, 500 KiB body handling, 1.8 MB combined-row guard, normalized published timestamps, per-source URL/ID dedupe, atomic article + FTS + pending completion, stale-lease protection, and article write reservations.
- Added conditional ETag/Last-Modified requests through the existing redirect-safe fetcher. Persisted validator values are dropped if they exceed 1 KiB.
- Source creation/configuration is gated by physical storage and export lock, with an atomic lock check inside the repository write. Disable/delete remain available during export or read-only storage; other source configuration changes remain blocked.
- Parse/fetch errors, HTTP status, Retry-After, and storage/query/subrequest stops flow into source and `fetch_runs` status. Sitemap-index parents remain retryable when child pages remain, with the normal source interval between retries.
- Wired `scheduled()` to `runScheduled()` through `waitUntil` and added the one-minute Cron configuration. No deployment or Cloudflare account resource was created.

## Test-first evidence

Changed/added test coverage in `tests/article-store.test.ts`, `tests/scheduler.test.ts`, `tests/worker-scheduled.test.ts`, `tests/pending-repository.test.ts`, `tests/sources-api.test.ts`, and `tests/http-fetch.test.ts`.

Initial focused RED command:

```text
npm test -- tests/article-store.test.ts tests/scheduler.test.ts tests/pending-repository.test.ts tests/sources-api.test.ts tests/storage-guard.test.ts
```

Exact aggregate output:

```text
Test Files  4 failed | 1 passed (5)
Tests       18 failed | 33 passed (51)
```

The failures showed missing article-store/scheduler modules, ungated source writes, and pending claim/failure writes not honoring the closed gate.

Additional focused REDs for review-discovered edge cases:

```text
npm test -- tests/article-store.test.ts -t 'returns_storage_limit_when_the_article_transaction_reports_280_MiB'
```

Before the fix, the article transaction returned `status: 'saved'` where `storage_limit` was required because the final statement’s smaller size obscured an intermediate 280 MiB result. After changing the implementation to retain the maximum `meta.size_after` across all transaction statements, the exact targeted result was `Test Files 1 passed (1); Tests 1 passed | 5 skipped (6)`.

```text
npm test -- tests/scheduler.test.ts -t 'reclaims_an_expired_export_lock'
```

RED: `Tests 1 failed | 12 skipped (13)`; `sourcesProcessed` was `0` rather than `1`. The scheduler now clears an expired export lock atomically with global-lease acquisition.

```text
npm test -- tests/scheduler.test.ts -t 'discards_oversized_conditional_headers'
```

RED: `Tests 1 failed | 13 skipped (14)`; a 2,048-byte ETag was persisted rather than discarded. The GREEN run was `Test Files 1 passed (1); Tests 1 passed | 13 skipped (14)`.

```text
npm test -- tests/sources-api.test.ts -t 'blocks_source_configuration_edits_but_allows_disable_and_delete'
```

RED: `Tests 1 failed | 12 skipped (13)`; disable-only PATCH returned 423 instead of 200. The fix allows disable/delete during export while still rejecting configuration changes.

```text
npm test -- tests/sources-api.test.ts -t 'prevents_a_source_insert_if_an_export_lock_starts_after_the_route_check'
```

RED: `Tests 1 failed | 13 skipped (14)`; repository insert resolved despite a newly active export lock. Source create/update SQL now checks the lock atomically, closing the race after a route-level precheck.

```text
npm test -- tests/pending-repository.test.ts -t 'stops_sustained_overload_below_300_MiB'
```

GREEN: `Test Files 1 passed (1); Tests 1 passed | 26 skipped (27)`. The real D1 fixture models growth from 270 MiB through the 280 MiB stop over ten persisted candidates, then proves the next invocation writes nothing, keeps the cursor at `story-9`, releases all reservations, and remains below 300 MiB. A test-fixture assertion was made order-independent because pending IDs are random; no production behavior changed for that correction.

Final focused GREEN command:

```text
npm test -- tests/article-store.test.ts tests/scheduler.test.ts tests/worker-scheduled.test.ts tests/sources-api.test.ts tests/storage-guard.test.ts tests/pending-repository.test.ts tests/http-fetch.test.ts
```

Exact output:

```text
Test Files  7 passed (7)
Tests       70 passed (70)
```

## Final verification

All checks below were run after the final code and test changes:

```text
npm test
Test Files  16 passed (16)
Tests       170 passed (170)

npm run typecheck
> tsc --noEmit
(exit 0)

npm run build
> wrangler deploy --dry-run --outdir dist --env ""
Total Upload: 258.26 KiB / gzip: 57.44 KiB
--dry-run: exiting now.

npm audit --omit=dev
found 0 vulnerabilities

git diff --check
(exit 0)
```

The build was a dry run only; no deployment or Cloudflare account resources were created.

## Concern / boundary

The `html_list` source kind currently follows the same direct-URL enqueue path as a single-article source. The approved Task 5 brief does not define a link-selector field or an HTML-list candidate contract, while Task 2’s existing `ArticleSelectors` describes article-content selectors. Supporting list pages properly needs that contract clarified rather than guessing a selector shape; the feed, sitemap, and direct-article ingestion paths are covered.
