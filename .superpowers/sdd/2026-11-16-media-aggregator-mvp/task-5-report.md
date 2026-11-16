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

## Original-round boundary (superseded by the fix below)

At the original Task 5 implementation, `html_list` followed the direct-URL enqueue path. The review ruling defined the missing `itemLink` contract, and fix round 1 below implements list-page discovery, so this is no longer an open concern.


## Review fix round 1/5

### Findings addressed

- Sitemap-index progress remains in `sources.sitemap_last_loc`; each pending child URL-set now stores its independent bounded `sitemap_cursor` in `pending_items`. The candidate insert/dedupe and cursor update use one D1 batch, and a child cursor advances only with a matching unexpired lease and confirmed persistence/dedupe. Cursor byte growth is included in the 24 MiB serialized metadata cap.
- `html_list` now requires `selectors.itemLink`. The list fetch resolves hrefs against the fetched list document URL (including a same-host redirect target), removes fragments, applies the existing public URL policy, and records unsafe/cross-host links as redacted terminal rows that cannot be claimed for fetch. Article-page `title`/`body` and optional metadata selectors remain in use for the discovered URLs. A legacy source without `itemLink` can still be disabled with PATCH.
- `runScheduled` uses `Date.now()` execution wall-clock time for due-source selection, the global/pending leases, retries, cleanup, and state writes. `scheduledTime` is kept only as the reported run start time.

### TDD evidence

- Initial combined RED command: `npm test -- tests/migrations.test.ts tests/scheduler.test.ts tests/sources-validation.test.ts tests/html-extractor.test.ts -t 'stores_a_bounded_cursor|drains_more_than_ten|requires_itemLink|rejects_itemLink|extracts_unique_relative|uses_execution_wall_clock'`. Output: `4 failed | 2 passed | 32 skipped`; failures showed the missing pending child cursor column, absent HTML-list extractor, missing `itemLink` requirement, and delayed delivery using stale time.
- Sitemap starvation RED: `npm test -- tests/scheduler.test.ts -t 'drains_more_than_ten_urls_from_each_sitemap_child_without_cursor_starvation'` failed because only 20 of the expected 24 distinct child URLs were queued. The regression was strengthened to fetch a sitemap index, assert separate `child-a`/`child-b` cursors while the source cursor remains at the index, and then prove all 24 URLs are eventually present.
- HTML-list RED: `npm test -- tests/sources-validation.test.ts tests/html-extractor.test.ts tests/scheduler.test.ts -t 'requires_itemLink_for_html_list_sources|rejects_itemLink_on_single_article_sources|extracts_unique_relative_links_and_redacts_unsafe_list_urls|discovers_html_list_links_then_applies_article_content_selectors'`. Output: `3 failed | 1 passed | 31 skipped`; failures were missing `extractHtmlListLinks`, acceptance of `html_list` without `itemLink`, and the scheduler treating the list URL as an article.
- Delayed Cron RED: `npm test -- tests/scheduler.test.ts -t 'uses_execution_wall_clock_for_due_sources_and_global_lease_when_scheduled_delivery_is_delayed'` failed with `sourcesProcessed` 0 (expected 1) because the stale scheduled timestamp made the source appear not due.
- Per-child cursor metadata RED: `npm test -- tests/pending-repository.test.ts -t 'does_not_exceed_the_metadata_cap_when_advancing_a_child_sitemap_cursor'` failed with `expected 1 to be +0`; the old accounting omitted the new `sitemap_cursor` bytes.
- Legacy disable RED: `npm test -- tests/sources-api.test.ts -t 'allows_disabling_a_legacy_html_list_source_without_itemLink'` returned HTTP 400 instead of 200 because PATCH revalidated the legacy selector set before disabling.
- Focused GREEN: `npm test -- tests/migrations.test.ts tests/pending-repository.test.ts tests/discovery.test.ts tests/scheduler.test.ts tests/sources-validation.test.ts tests/sources-api.test.ts tests/html-extractor.test.ts tests/storage-guard.test.ts tests/storage-physical-fill.test.ts` → `Test Files 9 passed (9); Tests 100 passed (100)`.
- Specific follow-up GREEN: the cursor-byte test → `Test Files 1 passed (1); Tests 1 passed | 27 skipped (28)`; the legacy disable test → `Test Files 1 passed (1); Tests 1 passed | 14 skipped (15)`; strengthened sitemap/list scheduler regressions → `Test Files 1 passed (1); Tests 2 passed | 15 skipped (17)`.

### Physical D1 check and verification boundary

A real local Miniflare D1 fill proved practical and is retained as `tests/storage-physical-fill.test.ts`. It inserts 575 bounded 500 KiB rows and checks actual D1 `meta.size_after` plus the shared gate. The full-suite run measured `295161856` bytes, above the 280 MiB stop (`293601280`) and below the 300 MiB hard cap (`314572800`); the gate returned `storage_limit`, persisted the measured size, and left no reservation. The focused stress test completed in about 1.1 seconds. This is real local D1 size, not a mocked threshold. Live Cron/Access remains untested because this task explicitly forbids deployment or creating Cloudflare account resources.

Final checks after all code/test changes:

```text
npm test
Test Files  17 passed (17)
Tests       180 passed (180)

npm run typecheck
> tsc --noEmit
(exit 0)

npm run build
> wrangler deploy --dry-run --outdir dist --env ""
Total Upload: 266.60 KiB / gzip: 58.63 KiB
--dry-run: exiting now.

npm audit --omit=dev
found 0 vulnerabilities

git diff --check
(exit 0)
```

No deployment or Cloudflare account resources were created. Independent scoped re-review is still required before Task 6.


### Final verification rerun after extending the real D1 fixture to include FTS rows

The durable physical test now writes 575 rows and then populates `articles_fts` before reading `meta.size_after`. Its focused command `npm test -- tests/storage-physical-fill.test.ts` passed (1/1) and measured 295215104 bytes. The final full-suite run after that test-only refinement passed 180/180 across 17 files; the physical test reported 295219200 bytes (280 MiB stop 293601280; 300 MiB cap 314572800) and completed in 1.44 seconds. Final `npm run typecheck` and `npm run build` both exited 0 (dry-run bundle 266.60 KiB / 58.63 KiB gzip); `npm audit --omit=dev` found 0 vulnerabilities; `git diff --check` exited 0. This final run supersedes the earlier interim physical-size sample above.


### Cursor replacement cap follow-up and final post-follow-up verification

A second, targeted metadata-cap test found that the SQL cursor update was comparing a replacement to the page’s initial cursor rather than the cursor written by the previous candidate in the same page. RED: `npm test -- tests/pending-repository.test.ts -t 'holds_a_child_cursor_when_a_duplicate_advance_would_exceed_the_metadata_cap'` failed because `deduplicated` was 2 rather than 1: the cursor incorrectly advanced beyond the last candidate that fit. The update now receives the currently persisted cursor for every candidate, so the byte delta is measured from the real row value. GREEN: `npm test -- tests/pending-repository.test.ts -t 'holds_a_child_cursor_when_a_duplicate_advance_would_exceed_the_metadata_cap|accounts_for_each_replacement_from_the_current_child_sitemap_cursor|does_not_exceed_the_metadata_cap_when_advancing_a_child_sitemap_cursor'` → `Test Files 1 passed (1); Tests 3 passed | 27 skipped (30)`.

Final full verification after that production fix: `npm test` → 17 files passed, 182 tests passed. The FTS-inclusive actual local D1 test measured `295215104` bytes (stop `293601280`, hard cap `314572800`) and completed in 1.15 seconds. `npm run typecheck` exited 0; `npm run build` exited 0 as dry run (266.59 KiB / 58.62 KiB gzip); `npm audit --omit=dev` found 0 vulnerabilities; `git diff --check` exited 0. These results supersede the preceding 180-test and physical-size rerun figures.
