# SDD ledger — plan: docs/superpowers/plans/2026-11-16-media-aggregator-mvp.md

## Scope / setup

- Repo root: `/workspace/media-aggregator`.
- Branch: `feature/media-aggregator-mvp` (new project branch).
- Design authority: `docs/superpowers/specs/2026-11-16-media-aggregator-design.md`.
- Execution: one implementer at a time; independent task review after each task; whole-branch review after Task 7.
- Preflight performed against the complete plan before Task 1.

## Preflight: each task's self-consistency

| Task | Files/tests/interfaces consistency | Result |
|---|---|---|
| 1. Worker foundation + D1 schema | Bootstrap config/dependencies precede test run; app factory, Env, migration and health tests are created in the same task; Cron remains a stub until Task 5. | Clean |
| 2. Auth + source API | Defines `Source`, `SourceInput`, `ArticleSelectors`; routes/repository/validation/tests are in scope; production and local auth are distinguished. | Clean |
| 3. URL policy + parsers | Defines common `Candidate`/`SourceCursor` types used by Task 4; tests cover parsing, redirects, limits and selectors. | Clean |
| 4. Durable pending backlog | Owns enqueue/claim/failure/cursor interfaces; Task 5 owns article completion. | Clean |
| 5. Scheduled ingestion + storage gate | Defines article types and storage/lease contracts; modifies named scheduler/source route/pending repository files. | Clean |
| 6. Article REST + FTS | Consumes Task 5's `Article` type and schema; modifies app route mount and its own routes/repository/cursor/tests. | Clean |
| 7. Export + restore + guide | Uses export tables from Task 1; locks ingestion/configuration from Tasks 2/5; modifies named routes and adds restore script/tests. | Clean |

## Preflight: shared files and interfaces

| Tasks | Shared file/interface | Producer → consumer | Finding / ruling |
|---|---|---|---|
| 1 → 2 | `src/app.ts`, `src/env.ts` | Task 1 creates app/Env; Task 2 adds auth/source routes and env values. | Compatible; additive. |
| 1 → 5 | `src/index.ts`, `src/env.ts`, `wrangler.jsonc` | Task 1 creates Worker/Env/config; Task 5 replaces scheduled stub and adds Cron. | Compatible; no duplicate handler. |
| 1 → 6 | `src/app.ts` | Task 1 creates app factory; Task 6 mounts article routes. | Compatible; additive. |
| 1 → 7 | `src/app.ts`, migration tables | Task 1 creates app/schema; Task 7 mounts export routes. | Compatible. |
| 2 → 3 | `ArticleSelectors` | Task 2 defines the type; Task 3 consumes it for extraction. | Compatible; exact type named. |
| 2 → 5 | `src/routes/sources.ts`, source repository | Task 2 creates CRUD; Task 5 adds storage-gate enforcement. | Compatible; file modification listed. |
| 3 → 4 | `Candidate`, `SourceCursor`, parser results | Task 3 defines types; Task 4 persists them. | Compatible after plan's exported type contract. |
| 4 → 5 | `src/ingest/pending-repository.ts` | Task 4 produces enqueue/claim/failure/cursor; Task 5 adds atomic article completion. | Compatible; ownership explicit. |
| 5 → 6 | `src/articles/types.ts` | Task 5 defines `Article`; Task 6 consumes it. | Compatible; type explicit. |
| 5 → 7 | `system_state` global lease/export lock | Task 5 checks lock; Task 7 acquires/releases it. | Compatible; ingestion pauses during export. |
| 6 → 7 | `src/app.ts` | Task 6 mounts article routes; Task 7 mounts export routes. | Compatible; additive. |
| 2 → 7 | `src/routes/sources.ts` | Task 2 creates source route; Task 7 blocks source config changes during export. | Compatible; modification listed. |

## Findings and rulings

- No remaining plan/spec conflicts or internal contradictions found in preflight.
- Ruling: no plan changes required before Task 1. The design is binding; tasks preserve Cloudflare Free-only, bounded D1, explicit URL validation, TDD, and no account deployment.
- The local test runtime rejected the initial `@cloudflare/vitest-pool-workers` against its bundled compatibility date. The coder switched to Cloudflare's replacement `@cloudflare/vitest-plugin` and compatibility date `2026-11-13`, matching the bundled runtime. Cost if wrong: local runtime may differ from a later production Workers runtime; revisit when dependencies/runtime are upgraded.

## Task 1: Worker foundation + D1 schema

- Base commit: `71e0f77d98dc1e52ffa6d43d033980f0663aeff1`.
- Implementer commit reported: `cdbc99b61ab25f1193221fdf0b7b7348e2ad4719` (`feat: scaffold worker and d1 schema`). Verified independently with `git status --short --branch`, `git rev-parse HEAD`, and `git log -1`: branch is `feature/media-aggregator-mvp`, HEAD is the reported commit, worktree clean.
- Reported RED: focused tests failed because app and schema were absent.
- Reported GREEN: `npm test` 2/2, `npm run typecheck`, and `npm run build` Wrangler dry-run passed; no deploy.
- Report file: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-1-report.md`.
- Diff package: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/review-71e0f77..cdbc99b.diff`.
- Independent review requested from the user's named reviewer. Task 1 remains gated until spec-compliance and quality verdicts are clean.

- Task 1 review round 1 found `published_at` unbounded in `pending_items` and `articles`, allowing D1 row-size overflow. Ruling: treat `published_at` as optional; normalize valid values to RFC3339 UTC text, maximum 64 UTF-8 bytes; represent invalid values as NULL and use `fetched_at` as the ordering fallback. Add D1 CHECK constraints and a migration test rejecting >64-byte values. Task 3 parser must enforce the same normalization. Cost if wrong: malformed source dates sort by fetch time instead of their supplied timestamp.

- Task 1 fix round 1/5 dispatched to the same implementer. Fix base: `cdbc99b61ab25f1193221fdf0b7b7348e2ad4719`. Scoped re-review is required before Task 2.

- Task 1 review fix: wrote `published_at_rejects_values_over_64_utf8_bytes` first and ran `npm test -- tests/migrations.test.ts`; RED reproduced because the pending insert accepted 65 bytes. Added nullable 64-byte UTF-8 CHECK constraints on `pending_items.published_at` and `articles.published_at`; GREEN: same command, 2/2 migration tests pass. Full `npm test` passed (3/3); typecheck and dry-run build passed. Parser normalization (RFC3339 UTC or NULL, with `fetched_at` ordering fallback) remains Task 3 scope per the ruling.

- Task 1 complete: fix round 1/5, finding addressed and re-review approved; commits `71e0f77..cdbc99b..447969f`, no open findings. Reported checks: migration RED→GREEN, full test suite 3/3, typecheck, dry-run build. Proceeding to Task 2.

- Task 2 dispatched to the requested coder at 2026-11-16 17:31 GMT+7. Base: `447969f267dbfa6c6484abc5bae2963abb443713`. Brief: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-2-brief.md`; report: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-2-report.md`.


Task 2: in_progress (base `447969f267dbfa6c6484abc5bae2963abb443713`); implementation and tests not yet started.
- Task 2 baseline: `npm test` passed (3/3). Wrote the auth, validation, and API tests before Task 2 production changes; RED run pending.

- Task 2 RED: `npm test -- tests/auth.test.ts tests/sources-api.test.ts tests/sources-validation.test.ts` before implementation failed as expected: 17 tests reported missing auth/validation modules and source routes. Added a 4 KiB URL limit test; `npm test -- tests/sources-validation.test.ts` failed because an oversized normalized URL was accepted, then passed after adding byte validation. Added disabled-source PATCH regression; `npm test -- tests/sources-api.test.ts` failed because PATCH re-enabled the source, then passed after preserving omitted `enabled`.
- Task 2 GREEN: focused tests passed 19/19; final `npm test` passed 22/22 across 5 files; `npm run typecheck` passed; `npm run build` Wrangler dry-run passed (76.34 KiB / 19.32 KiB gzip). `git diff --cached --check` passed. No account resources or deployment.
Task 2: complete (commits 447969f..fa57ca5, tests: npm test → [2m   Duration [22m 2.67s[2m (transform 513ms, setup 0ms, import 731ms, tests 519ms, environment 2ms)[22m)
- Task 2: minor (deferred): PATCH with explicit `poll_interval_sec: null` is accepted as a no-op; final whole-branch review should decide whether to reject it.
- Task 2 out-of-scope follow-ups carried forward: Task 3 enforces public/private host and redirect policy before fetch; Task 7 guide must ensure Access protects `/health` and `/v1/*` on the custom hostname.
- Task 2 fix round 1/5 approved: generic JSON 500 finding addressed; no new breakage. Task 2 complete across commits `447969f..fa57ca5..9defcc9`; coder-reported full suite 25/25, typecheck and dry-run build.
- Design/plan clarification commit `7fe76023bccea75250d1b6e32894627656751506`: `published_at` max 64 UTF-8 bytes, Task 3 normalizes valid dates to RFC3339 UTC and invalid dates to NULL, Task 5 reuses the helper; Task 7 guide covers Access on `/health` and `/v1/*`.

- Task 2 fix round 1/5: finding addressed, no new breakage; scoped re-review approved. Task 2 complete across commits `447969f..fa57ca5..9defcc9`. Coder-reported full suite 25/25, typecheck, dry-run build.
- Task 2 minor deferred: explicit `PATCH poll_interval_sec: null` remains accepted as a no-op; include in final whole-branch review.
- Task 2 cross-task follow-ups carried forward: Task 3 public/private host and redirect enforcement; Task 7 Access must cover `/health` and `/v1/*`.
- Design/plan updated for `published_at` max 64 UTF-8 bytes; Task 3 normalizes valid values to RFC3339 UTC, invalid values to NULL; Task 5 reuses normalizer. Task 7 docs now explicitly cover Access on `/health` and `/v1/*`.

- Task 3 dispatched to the requested coder. Base `7fe76023bccea75250d1b6e32894627656751506`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-3-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-3-report.md`.


Task 3 implementation complete on `9822977870f1d5d554fab5c98fef0021636e5092`; independent review pending.
Task 3: Ruling: `parseFeed(body, contentType)` cannot know a source ID, while Task 4's `enqueueCandidates(..., source, candidates, ...)` does; keep `Candidate.sourceId` optional and let discovery attach it from `Source` before persistence — this preserves the specified parser signature and prevents inventing an ID — cost if wrong: a direct parser consumer must bind source context before enqueueing.
Task 3: Ruling: `parseSitemap(body)` has no incoming cursor, so truncating its output to 100 makes a >100-entry sitemap permanently starve later locations; return the full deduplicated set under the 2 MiB/50,000-node parser caps and let Task 4 filter from the durable cursor and process at most 100 per response — this reconciles Task 3's >100-entry contract with the design's bounded discovery — cost if wrong: one parse may retain more than 100 locations, but input and node counts remain strictly capped.
Task 3: implementation complete (commit `9822977870f1d5d554fab5c98fef0021636e5092`, coder-reported focused 59/59 and full 84/84 tests; Task 3 independent review is still pending).

- Controller gate: implementation commit `9822977870f1d5d554fab5c98fef0021636e5092`, clean HEAD verified; coder reports focused 59/59, full 84/84, typecheck, dry-run build, audit 0 vulnerabilities. Independent reviewer has the diff. DNS rebinding caveat remains open pending review; do not start Task 4 until the verdict is clear or any important finding is fixed and re-reviewed.

- Task 3 review ruling: retain the design's max-100-candidates-per-parse budget, but make `parseFeed` explicitly resumable by item `SourceCursor`. Return `hasMore` and `cursorFound`; Task 4 passes the last safely persisted candidate cursor (never the parser's final returned cursor). If the saved cursor has fallen out of the current feed, restart at the first batch and dedupe; entries already removed by the publisher remain unrecoverable per the documented no-pagination limitation. This addresses the review blocker without unbounded parse output or silently repeating the first 100 forever. Add >100 pagination tests and carry the cursor behavior into Task 4.

- Task 3 review round 1: feed parsers silently stop at 100 without continuation, data-loss blocker before Task 4.
- Ruling: retain max-100 parse pages; add `afterCursor`, `hasMore`, `cursorFound`, and `nextCursor`. Advance only through candidates safely persisted or deduped; if saved cursor is gone, restart at page one and dedupe; reset to null only after a valid cursor yields an empty page. Spec/plan clarified; test >100 items across 10-item storage invocations.
- Task 3 fix round 1/5 dispatched to original implementer, base `9822977870f1d5d554fab5c98fef0021636e5092`; scoped re-review required before Task 4.
- Task 3 cross-task follow-ups: Task 4 must bind source ID, enforce same-source-host candidates and pending metadata byte caps. Reviewer found no concrete DNS-rebinding blocker for Cloudflare Worker's proxied outbound model, but this is not standalone SSRF protection or safe for untrusted source creation on another runtime.

- Task 3 fix round 1 commit `d05da8f5c0e63ed06a327428b46ba4b6d36faf9e`; report includes RED (five pagination tests fail), GREEN (five pass; all 205 RSS/Atom/JSON items traversed across three pages), feed suite 17/17, full suite 89/89, typecheck, dry-run build. Review package `.superpowers/sdd/2026-11-16-media-aggregator-mvp/review-9822977..d05da8f.diff` sent for scoped re-review; Task 4 remains gated.

- Task 3 fix round 1 re-review: NOT APPROVED. Pagination works with unique cursor values, but duplicate external IDs/canonical URLs can cause `findIndex` to repeat the earlier occurrence and stall/replay the page. This joins the still-open >100-feed continuation blocker.
- Task 3 ruling: deduplicate `Candidate` values by `dedupeKey` (external ID, otherwise canonical URL) before pagination; this matches the persistence identity and ensures cursor uniqueness. Keep 100-item pages, and add ID/URL duplicates spanning page boundaries plus a termination/progress assertion.
- Task 3 fix round 2/5 dispatched to original implementer, base `d05da8f5c0e63ed06a327428b46ba4b6d36faf9e`; re-review both open findings before Task 4.

- Task 3 fix round 2 commit `4b3678e92fb82dd9b9d63fb218bc56685f19283e`; report records two RED failures for duplicate IDs/no-ID URLs, then 2/2 GREEN; parser suite 19/19, full suite 91/91, typecheck, dry-run build. Diff package `.superpowers/sdd/2026-11-16-media-aggregator-mvp/review-d05da8f..4b3678e.diff` sent for re-review of both open findings; Task 4 remains gated.

- Task 3 fix round 2/5: both >100-feed continuation and duplicate-cursor findings addressed; no new breakage; scoped reviewer approved. Task 3 complete through `9822977..d05da8f..4b3678e`; coder reports full suite 91/91, typecheck, dry-run build. DNS caveat remains documented but not a blocker for Cloudflare Workers proxied egress; not a standalone SSRF policy for other runtimes/untrusted sources.
- Documentation commit `2bf345fff9b9cb08a052ede105ea829c019fdbcc` incorporates timestamp, Access, and cursor-safe pagination contracts.
- Task 4 dispatched to the requested coder; base `2bf345fff9b9cb08a052ede105ea829c019fdbcc`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-4-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-4-report.md`.

Task 4: Ruling: pending item leases expire after 120 seconds — the approved design requires reclaimable leases but does not specify their duration; 120 seconds safely exceeds the 10-second per-fetch timeout and allows a timed-out invocation to be reclaimed — cost if wrong: reclaim can be delayed up to two minutes after a worker stops, or an unusually long invocation could have its lease reclaimed early.
Task 4 cross-host ruling: record cross-host item as terminal `blocked_external_host` (not eligible for `claimPending`/fetch); advance cursor only after the blocked row is atomically persisted or dedupe is confirmed; if it cannot fit, leave the cursor before it. This follows the approved design and the assigning Agent's clarification.
Task 4: complete (commits 2bf345f..e09d545, tests: npm test → [2m   Duration [22m 4.34s[2m (transform 1.49s, setup 0ms, import 2.65s, tests 3.28s, environment 3ms)[22m)


- Task 4 review round 1: spec BLOCKED; task quality needs fixes. Critical: pending writes lack the 280/300 MiB physical D1 gate. Important: unsafe feed/sitemap URLs are filtered out by Task 3 parsers before Task 4 can record bounded terminal outcomes, allowing silent loss/cursor reset. Minor deferred to final review: disabled sources report `unsupported_source` instead of `disabled_source`.
- Task 4 Ruling: introduce the shared physical D1 write-gate foundation on the pending-write path in this fix round; Task 5 will extend/reuse it for article/source/run writes under the global lease. The approved design requires checking size before durable ingestion writes, so deferring all enforcement leaves pending growth unprotected — cost if wrong: an early shared abstraction may need small refactoring when the scheduler arrives.
- Task 4 Ruling: expose unsafe feed/sitemap entries as bounded non-fetchable terminal `blocked_unsafe_url` outcomes, with no raw unsafe URL payload; advance the relevant cursor only after the terminal record persists or dedupe is confirmed, and hold it if caps prevent recording. This reconciles URL rejection with the global no-silent-loss rule — cost if wrong: malformed or hostile feed entries create bounded diagnostic rows, pruned after 30 days.
- Task 4 round-1 re-review follow-ups carried to Task 5: invoke terminal-pending cleanup on schedule; verify one-source/one-feed-fetch/two-article-fetch bounds and visible source/run status for parse/fetch errors. The Task 4 review could not verify these because the scheduler is Task 5 scope.
- Task 4 review supplemental report added another Important finding to round 1: discovery may invoke `db.batch` up to 100 times per page (`src/ingest/discovery.ts:99-101`; `src/ingest/pending-repository.ts:252-323`), exceeding D1 Free's 50-query-per-Worker-invocation limit when duplicates are processed because only new rows count toward the 10-row cap. Bound total candidates checked/DB calls per invocation or batch accounting while preserving cursor stop-on-first-unaccounted. This joins the open round-1 findings before the coder completes its fix.

- Task 4 review round 1 supplemental finding 2: Important — per-candidate `db.batch` calls may run up to 100 times per invocation; when duplicates are accounted, the 10-new-row cap does not bound calls. Keep D1 batch-call/query use within Free's 50-per-invocation limit by bounding candidates examined or batching while preserving stop-on-first-unaccounted. Official D1 limits: https://developers.cloudflare.com/d1/platform/limits/ (`db.batch()` counts as one query toward this invocation limit).


- Task 4 review fix round 1 committed as `62a002c366bdad51809f7471488925d1f09fcfe6` (`fix: gate pending writes and account rejected candidates`), based on `e09d545`. Added shared reservation-backed `meta.size_after` gate, 280/300 MiB states, bounded unsafe feed/sitemap terminal candidates, ≤25 candidate checks per invocation, and gated cursor reset writes. Plan/spec/brief were updated. RED evidence: initial focused 4-file run `9 failed | 54 passed (63)`; migration state test `1 failed | 2 passed`; denied-reservation size observation `1 failed`; cursor reset at closed gate `1 failed`; safe-ID/unsafe-hash namespace collision `1 failed`. Focused GREEN: six files, 73/73; full suite 138/138; typecheck, Wrangler dry-run build (76.62 KiB / 19.38 KiB gzip), audit 0 vulnerabilities; `git diff --check` clean. Report appended in `task-4-report.md`. Deferred minor `disabled_source` remains unchanged; await scoped re-review before Task 5. Ruling: denied writes expose `storage_limit` through the returned result and global `system_state`; do not add an unreserved source-row write after gate denial, so that per-source status may stay stale until Task 5 records the run result.

- Task 4 fix round 1/5 re-review: all three Critical/Important findings addressed; no new breakage; reviewer approved. Commits `2bf345f..e09d545..62a002c`. Reported verification: focused 73/73, full 138/138, typecheck, Wrangler dry-run build, audit 0 vulnerabilities; worktree clean.
- Task 4 complete: implementation and independent fix review approved. Deferred Minor: disabled sources still report `unsupported_source` rather than `disabled_source`; carry to final whole-branch review.
- Task 5 integration checks carried forward from Task 4 re-review: account for every D1 call (including direct `run`/`first`, not just `batch`) in the per-invocation query budget; ensure `claimPending` and `markPendingFailure` transitions respect the storage policy; verify the one-source/one-feed-fetch/two-article-fetch limits, visible source/run error status, and scheduled terminal-row cleanup.

- Task 5 dispatched to the designated coder on base `62a002c366bdad51809f7471488925d1f09fcfe6`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-5-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-5-report.md`. Task 4 re-review approved. Carry-forward: account for all D1 calls under the Free per-invocation cap; ensure pending claim/failure state writes obey storage policy; run terminal cleanup; enforce one source, one feed/sitemap fetch and ≤2 article fetches; expose parse/fetch failures through source/run status.


- Task 5 implemented and committed on `feature/media-aggregator-mvp` as `feat: ingest feeds and store bounded full text`, based on approved Task 4 commit `62a002c366bdad51809f7471488925d1f09fcfe6`.
- Scheduler reuses the shared measured/reservation-backed storage gate, counts every D1 statement and batch plus outbound fetch hops under the Worker 50-subrequest cap, holds one global lease, cleans terminal pending/fetch-run rows, and respects one-source/sitemap plus two-article fetch bounds. Article + FTS + pending completion is atomic and lease-checked. Source creation/configuration is gated by storage/export lock; disable/delete remain allowed. All HTTP writes and scheduler statuses are bounded and failures visible.
- TDD: initial focused RED was 18 failed / 33 passed (51 total). Later focused REDs reproduced the 280 MiB article-transaction peak being hidden by a later smaller statement size, expired export lock preventing scheduler progress, oversized conditional header persistence, disable operations incorrectly blocked during export, and a race allowing a source insert after the route lock check. Corresponding focused GREEN runs passed. Sustained-overload fixture passed and kept observed D1 size at 280 MiB, cursor at the last persisted item (`story-9`), and no cursor advance or extra row on the next run.
- Final verification: focused Task 5 suite 70/70 across 7 files; full suite 170/170 across 16 files; `npm run typecheck`; Wrangler dry-run build (258.26 KiB / 57.44 KiB gzip); `npm audit --omit=dev` (0 vulnerabilities); `git diff --check` clean. No deployment or Cloudflare account resources created.
- Report: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-5-report.md` (TDD commands/results, implementation summary, final verification, and boundary notes).
- Open boundary for independent review: `html_list` is currently enqueued as a direct URL like `article`; Task 5 brief/Task 2 `ArticleSelectors` do not define a list-link selector/candidate contract. Do not silently invent one; clarify/assign if list-page discovery is required. Await scoped independent review before Task 6.


- Task 5 review round 1: spec NEEDS FIX. Critical: a single `sources.sitemap_last_loc` is shared across top-level sitemap-index pages and multiple child URL-sets, allowing cursor overwrite/starvation. Important: `html_list` is treated as a direct article URL although the approved design requires public list-page link extraction via CSS selector. Important: lease/eligibility/retry time is derived from `scheduledTime`, which is event scheduled time, not invocation execution time; a delayed event can acquire expired leases or create immediately expired pending/backoff state. Reviewer also noted physical-size overload test uses a D1 proxy rather than physically filling local D1; live Cron/Access was not deployed per the no-account-resources rule.
- Task 5 Ruling: store a durable independent cursor on each pending child sitemap; keep `sources.sitemap_last_loc` for top-level sitemap index progress, and atomically persist each child cursor with that child’s discovered candidates. This is the smallest robust fix for interleaving multi-child URL-sets — cost if wrong: small schema/API migration before deployment, still local-only.
- Task 5 Ruling: add an explicit `itemLink` CSS selector for `html_list` sources, required for that kind; extract anchor `href` links from the list page, resolve relative links against the list URL, validate them through existing same-host/public URL policy, and enqueue as article candidates. Keep `title/body` and other existing selectors for each article page. The approved design explicitly requires list-page CSS-selector discovery, so direct-URL behavior alone is incomplete — cost if wrong: adding the selector field expands the source API before deployment, but is backward-safe for other kinds.
- Task 5 Ruling: use actual execution wall-clock time (`Date.now()`) for global/pending leases, due-source eligibility, and retry deadlines; keep `scheduledTime` only for run/report timestamps. Cloudflare documents `scheduledTime` as the time an event was scheduled, not the Worker’s execution time — cost if wrong: scheduler state may shift relative to the nominal trigger timestamp, which is appropriate for leases/backoffs.
- Task 5 review follow-up: resolve whether the local test binding can support an actual physical-size stress check without creating remote resources; if not practical, document evidence showing the production gate consumes real D1 `meta.size_after` and explain the remaining boundary. Production Cron/Access behavior remains unverified until a separately approved deployment and is not part of this local-only task.

- Task 5 verification ruling: do not create or deploy Cloudflare resources to exercise live Cron/Access because account deployment was explicitly deferred to separate owner approval. Record these as environment-boundary limitations in the final guide. The local overload test simulates threshold `meta.size_after`; production gate consumes D1's actual metadata, and the local ordinary-size test compares stored observation with actual local D1 `meta.size_after`. Ask coder whether a larger physical local D1 fill test is practical without destabilizing the suite; absent that, retain simulation plus direct-binding evidence and disclose the limitation. Cost if wrong: local tests would not expose divergence in D1 physical-size reporting near the hard cap.


- Task 5 review fix round 1/5: implemented independent per-child sitemap cursors with lease-conditioned atomic advancement and cursor-byte cap accounting; `html_list` now requires `itemLink`, extracts same-host/public hrefs and persists redacted unsafe/external terminal rows; scheduler eligibility/leases/retries use execution wall-clock while scheduled time remains reporting-only. Disable-only PATCH remains available for a legacy html_list source missing `itemLink`.
- TDD evidence: combined RED `4 failed | 2 passed | 32 skipped`; html_list RED `3 failed | 1 passed | 31 skipped`; child sitemap regression RED (20/24 URLs); delayed-event regression RED (`sourcesProcessed` 0 expected 1); child cursor-byte cap RED (`inserted` 1 expected 0); legacy disable RED (400 expected 200). Focused GREEN 100/100 across 9 files.
- Physical D1 stress was practical and is retained in `tests/storage-physical-fill.test.ts`: actual local D1 `meta.size_after=295161856` bytes (280 MiB stop=293601280; 300 MiB cap=314572800), gate returned `storage_limit`, no reservation remained. No deploy/account resources.
- Final verification for fix round: full suite 180/180 across 17 files; typecheck passed; Wrangler dry-run build passed (266.60 KiB / 58.63 KiB gzip); production audit 0 vulnerabilities; `git diff --check` clean. Append evidence to `task-5-report.md`; fix-round commit/re-review pending. Task 6 remains gated on independent approval.
- Task 5 cursor-cap follow-up: test-first RED reproduced an incorrect child cursor advance when a later duplicate cursor replacement exceeded the aggregate metadata cap (`deduplicated` 2, expected 1); fix passes the current persisted cursor through each write. Focused cursor-cap tests passed 3/3. Final after this fix: full suite 182/182 across 17 files; physical local D1 + FTS measured 295215104 bytes (280 MiB stop 293601280; 300 MiB cap 314572800), then stopped with `storage_limit`; typecheck, dry-run build (266.59 KiB / 58.62 KiB gzip), audit 0 vulnerabilities, and diff-check passed. This supersedes prior interim counts.


- Task 5 fix round 1/5 re-review: all three Important/Critical findings addressed; no new breakage; reviewer approved. Commits `581bd52..dcbfa9c`. Final reported full suite 182/182 across 17 files, typecheck/build/audit pass; real local D1+FTS stress run measured 295,215,104 bytes and stopped at 280 MiB; worktree clean.
- Task 5 complete. Live Cron/Access remains intentionally untested without separate deployment/resource approval. Task 5 report records `html_list.itemLink`, per-child sitemap cursor, and wall-clock lease changes.
- Task 6 dispatched to the designated coder on base `dcbfa9c8fcaeae144bdc2de5ca8794b8e4a0decc`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-6-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-6-report.md`. Task 7 brief is prepared but must not start until Task 6 is implemented and independently reviewed.


- Task 6 review: Spec Compliance PASS; Task quality APPROVED. No Critical/Important findings. Deferred Minor for final review: add API-level `/v1/articles` coverage proving valid `source_id`, `from`, `to`, `q`, and cursor values propagate to filtered repository results. Reviewer confirmed Task 6 independently; the earlier unsupported coder claim was corrected before actual review.
- Task 6 complete: commit `dcbfa9c..d2cd67a`, 196/196 tests, typecheck and Wrangler dry-run pass. Live Access/Cron remains untested without deployment approval.
- Task 7 dispatched to designated coder on base `d2cd67a77f51ad810b276da8c94ca27dc27bede0`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-7-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-7-report.md`. Keep the no-deploy/no-resource-creation boundary. After Task 7 review, run the mandated whole-project spec/quality review and independent final verification.


- Task 6 independent review: Spec Compliance PASS and Task quality APPROVED; no Critical/Important findings. Deferred Minor: extra route-level test proving valid `source_id`, `from`, `to`, `q`, cursor parameters propagate from `/v1/articles` to filtered results; final review should triage. Reviewer did not rerun tests. Corrected the implementer report’s prior unsupported approval claim before this real review.
- Task 6 complete: `dcbfa9c..d2cd67a`; reported 196/196 tests, typecheck, Wrangler dry-run build pass; no deployment.
- Task 7 dispatched on base `d2cd67a77f51ad810b276da8c94ca27dc27bede0`; brief `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-7-brief.md`; report `.superpowers/sdd/2026-11-16-media-aggregator-mvp/task-7-report.md`. Task 7 is the final implementation stage, followed by its independent review and the whole-project final review.


- Task 7 review round 1: spec NEEDS FIX. Important: `getExportPage` repeats three full-table `COUNT(*)` scans on every page, leading to ~11.12M rows read for a 10,000-record snapshot across 1,112 pages, before page queries; this can exceed the D1 Free 5M/day read quota. Fix by caching counts once per export session or otherwise eliminating repeated full scans, with a large-export read-budget regression.
- Task 7 Minor deferred to final review: operations backup example creates a likely mode-0644 full-text export file under umask 022; make backup creation private/exclusive if touched by final review. Task 7 Minor deferred to final review: completed/expired `export_sessions` are not purged, so repeated exports grow D1 rows outside the ingestion gate; assess retention/storage-cap impact. These minors do not block fix round 1.
- Task 7 Cannot-verify items: production Access/Cron remains untested as no deployment or account resource is authorized; reviewer found documentation quota/Time Travel figures current. No live action is permitted.


- Task 7 fix round 1/5 re-review: Important read-quota finding addressed; reviewer approved; no new breakage. Cached snapshot counts are written with export session creation and reused on each page. Commit range `3dc3269..00b9be9`; reported large export RED 11,136,680 rows read / 1,112 repeated counts, GREEN 26,682 rows read / one count statement for 10,000 records and 1,112 pages. Full suite 206/206, lint/typecheck/build/audit pass; no deploy.
- Task 7 complete (implementation + independent fix review approved). Deferred Minors for final whole-project review: (1) operations backup shell example should set private permissions/use exclusive creation; (2) completed/expired export_session rows have no retention/cleanup and may grow D1 outside the ingestion gate. Task 6 Minor also deferred: API-level valid filter propagation test. Task 4 Minor remains deferred: disabled sources report `unsupported_source` rather than `disabled_source`.
- All seven plan tasks have implementation and independent per-task review gates completed. Whole-project review now starts from root/base commit `71e0f77d98dc1e52ffa6d43d033980f0663aeff1` through HEAD `00b9be9ca7ef4f85c71d09d412e441858cd48194`; final review must triage all deferred Minors and inspect final VCS diff. Do not deploy or create Cloudflare resources.


- Final whole-project review against `71e0f77..00b9be9`: not ready to merge. One Critical: exported `content_too_large` article has empty stored text but hash of original oversized text; restore hashes exported text and rejects the backup. Four Important: API has no per-service-token rate limit as required by spec; `GET /v1/sources` lacks per-source pending/oldest backlog and no route reports global observed D1 size/storage state; disabling a source does not stop queued pending fetches and status uses `unsupported_source`; no realistic Worker CPU/throughput measurement against Free 10 ms budget. Five Minor: explicit-null `poll_interval_sec` no-op; valid API filter-propagation coverage absent; backup example may create mode-0644/truncate a same-second file; export-session rows are never purged and grow outside storage gate; full-project ESLint has five findings and `npm run lint` scopes only a subset. Reviewer could not verify live Access/Cron/CPU due no-deploy constraint, and judged DNS rebinding non-blocking only for Workers' proxy; reviewer set aside excluded social/dynamic/paywall content and removed-feed items per spec.
- One final-review fix wave dispatched to the designated coder on base `00b9be9ca7ef4f85c71d09d412e441858cd48194`, covering all findings above with TDD where code changes, full checks, one commit, and one scoped re-review. No deployment/resource creation.

- Final whole-project review fix wave on base `00b9be9`: all listed Critical/Important/Minor findings addressed. Report: `.superpowers/sdd/2026-11-16-media-aggregator-mvp/final-review-fix-report.md`. Verification: 217/217 tests, full-project lint, typecheck, both Wrangler dry runs, audits found 0 vulnerabilities, diff check clean. Local fixture: parse median 6 ms/max 10 ms and persisted 100 pending rows in ten batches; production billed CPU remains unverified. No deploy or remote resources.
