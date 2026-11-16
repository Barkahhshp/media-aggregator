# Media Aggregator MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal Cloudflare Free-only RSS/news aggregator that stores full article text within bounded D1 capacity and serves it through an authenticated REST API.

**Architecture:** One TypeScript Cloudflare Worker handles REST routes and a one-minute Cron Trigger. D1 stores sources, durable discovery backlog, articles, FTS5 title/snippet index, and export state; Cloudflare Access protects production ingress. Fetch adapters use ordinary HTTP for RSS/Atom/JSON Feed, sitemap, and configured public HTML selectors. No R2, Queue, external browser, paid service, X, or YouTube.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/Wrangler, D1 + SQLite FTS5, `HTMLRewriter`, `fast-xml-parser`, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-11-16-media-aggregator-design.md`

## Global Constraints

- Project path: `/workspace/media-aggregator`; never deploy or create account resources during local implementation.
- Cloudflare Free only; one D1 database; no R2, Queues, Supabase, paid APIs, Browser Run, Playwright, or external runtime.
- Production ingress uses Cloudflare Access Service Auth on a custom hostname; `workers_dev` is disabled. Without a hostname, keep deployment local-only.
- REST list defaults to 20 items and caps at 100; article pagination is stable, cursor-based; article detail returns full text.
- Full text is at most 500 KiB UTF-8 per article. Aggregate D1 row content must remain below 1,800,000 bytes; reject with `row_too_large`.
- Stop ingestion at 280 MiB physical D1 size; absolute application cap is 300 MiB. Measure with D1 `meta.size_after` including indexes/FTS.
- Cloudflare Free D1 allows at most 50 queries per Worker invocation; bound duplicate accounting as well as new inserts so `db.batch()` use remains under that limit.
- Pending backlog maximum is 2,000 rows and 24 MiB serialized metadata. Pending text/URL fields obey design caps; successful pending rows are deleted atomically with article/FTS upsert; terminal failures expire after 30 days.
- At most one source is scheduled per invocation, one feed/sitemap fetch plus two article fetches, at most 10 newly persisted candidates, and at most 25 candidates checked/accounted per invocation. Do not advance any cursor beyond successfully persisted or deduplicated candidates.
- Allow at most 100 active sources; default polling interval is two hours, minimum 15 minutes; freshness is best-effort, not an SLA.
- Fetch only HTTP/HTTPS ports 80/443; manually validate redirects, same-host only, maximum 3 hops; reject private/reserved/local targets and URLs with userinfo.
- Use Cloudflare Access in production; local/test uses an explicit local Bearer token. Never log auth material.
- Export pages contain at most 10 records and at most 3 MiB serialized UTF-8. Snapshot includes schema version, sources, source state/watermarks, pending items, articles, and text; restore is tested.
- External source errors, disabled sources, or size limits must be visible; never silently drop an unpersisted candidate.
- Every feature uses RED → GREEN → REFACTOR. No production code before a test is observed failing.

## Review Focus

1. Malicious, encoded, private-address, cross-host, and multi-hop redirect URLs must fail before protected content is fetched.
2. Feed/sitemap cursor and pending backlog must survive partial persistence, source changes, retries, and overload without skipping unpersisted discoveries.
3. D1 storage and row-size guardrails must stop every growth path, including FTS/index and pending records, before the 300 MiB cap.
4. Export must be a bounded, immutable snapshot and restore all source state, pending backlog, and article text without duplication or loss.
5. Access/local authentication, malformed requests, and error logging must never expose a secret or turn a rejected request into a source fetch.

---

### Task 1: Worker foundation and D1 schema

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `src/env.ts`, `src/app.ts`, `src/index.ts`, `src/routes/health.ts`
- Create: `migrations/0001_initial.sql`
- Test: `tests/health.test.ts`, `tests/migrations.test.ts`

**Interfaces:**
- `Env` provides `DB: D1Database`, `APP_ENV: 'test' | 'local' | 'production'`, and optional `API_TOKEN` for local/test only.
- `createApp(): Hono<{ Bindings: Env }>` builds the app without global side effects.
- Worker default export exposes `fetch` via Hono and `scheduled` as a stub that returns safely until Task 5.
- Initial migration defines `sources`, `pending_items`, `articles`, `fetch_runs`, fixed `system_state`, `export_sessions`, indexes, and `articles_fts`; migrations use strict SQLite constraints and timestamps.

- [ ] **Step 1: Create test-only package/Vitest/Wrangler/TypeScript configuration and install dependencies, then write failing health and schema tests**
  - `health_returns_minimal_json_without_secrets`: assert status 200 and only `status` + `service` fields.
  - `migration_creates_required_tables_and_indexes`: apply migration to local D1 and assert the expected tables/indexes exist.
- [ ] **Step 2: Run `npm test -- tests/health.test.ts tests/migrations.test.ts`; verify RED** because the Worker and schema do not exist.
- [ ] **Step 3: Add the migration, app factory, and health route** in the listed files. Use Hono for routing; set `workers_dev: false` for production; configure one Cron `* * * * *` only when the scheduled handler lands in Task 5.
- [ ] **Step 4: Run the two focused tests and then `npm test`; verify GREEN.**
- [ ] **Step 5: Run `npm run typecheck` and `npm run build`; commit `feat: scaffold worker and d1 schema`.**

### Task 2: Local authentication and source-management API

**Files:**
- Create: `src/auth/local-token.ts`, `src/routes/sources.ts`, `src/sources/types.ts`, `src/sources/validation.ts`, `src/sources/repository.ts`
- Modify: `src/app.ts`, `src/env.ts`
- Test: `tests/auth.test.ts`, `tests/sources-api.test.ts`, `tests/sources-validation.test.ts`

**Interfaces:**
- `authenticateLocal(request: Request, env: Env): Response | null` requires `Authorization: Bearer <API_TOKEN>` in test/local; production trusts the Access-protected route and rejects calls without Access assertion header.
- `Source`, `SourceInput`, and `ArticleSelectors` are defined in `src/sources/types.ts`; `ArticleSelectors` is `{ title: string; summary?: string; author?: string; publishedAt?: string; itemLink?: string; body: string }`; `itemLink` is required by validation for `html_list` only, and Task 3 article extraction keeps using title/body selectors.
- `validateSourceInput(input: unknown): SourceInput | ApiError` validates kind, URL, interval, selectors, and encoded byte limits.
- `createSource(db: D1Database, input: SourceInput): Promise<Source>`; `updateSource(...)`; `listSources(...)`; `disableSource(...)`.
- `SourceInput` supports `feed`, `sitemap`, `article`, and `html_list`; `html_list` requires `selectors.itemLink` to extract list-page hrefs, while the other configured selectors apply to fetched article pages.

- [ ] **Step 1: Write failing tests** for missing/wrong local token, correct local token, production refusing to treat local `API_TOKEN` as Access authentication, valid/invalid source kinds, max 100 active sources, default interval 7,200 seconds, minimum 900 seconds, and source body limits.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement local auth middleware, source validation/repository, and `GET/POST/PATCH/DELETE /v1/sources` routes.** Production requests must pass through Access; local tokens must not be accepted as a production fallback.
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.**
- [ ] **Step 5: Run typecheck/build; commit `feat: add authenticated source management`.**

### Task 3: URL policy, feed/sitemap parsing, and article extraction

**Files:**
- Create: `src/ingest/url-policy.ts`, `src/ingest/http-fetch.ts`, `src/ingest/feed-parser.ts`, `src/ingest/sitemap-parser.ts`, `src/ingest/html-extractor.ts`, `src/ingest/types.ts`
- Test: `tests/url-policy.test.ts`, `tests/http-fetch.test.ts`, `tests/feed-parser.test.ts`, `tests/sitemap-parser.test.ts`, `tests/html-extractor.test.ts`

**Interfaces:**
- `normalizeAndValidateUrl(input: string, expectedHost?: string): URL` rejects non-HTTP(S), userinfo, non-80/443 ports, localhost/private/reserved/numeric-encoded hosts, and cross-host targets when `expectedHost` is supplied.
- `fetchPublicUrl(url: URL, sourceHost: string, limits: FetchLimits): Promise<FetchResult>` uses `redirect: 'manual'`, validates each redirect, and caps 3 hops, 10-second timeout, and 2 MiB response bytes.
- `parseFeed(body: string, contentType: string, afterCursor?: SourceCursor): ParsedFeed` supports RSS, Atom and JSON Feed; returns at most 100 canonical provisional candidates after the cursor, plus `hasMore`, `cursorFound`, and the last returned `nextCursor` so later pages can be reached.
- `parseSitemap(body: string): ParsedSitemap` supports urlsets and sitemap indexes with cursorable URLs.
- `extractArticle(html: string, selectors: ArticleSelectors): ExtractedArticle` uses `HTMLRewriter` to extract configured title/summary/author/time/body.
- `normalizePublishedAt(value: string | null | undefined): string | null` parses valid dates and serializes them as RFC3339 UTC text; invalid values return `null`. Task 5 article writes call this same helper.
- Export `Candidate`, `SourceCursor`, `FetchLimits`, `FetchResult`, `ParsedFeed`, `ParsedSitemap`, and `ExtractedArticle` from `src/ingest/types.ts`; `ParsedFeed` includes `hasMore`, `cursorFound`, and `nextCursor`. `Candidate` carries source ID, dedupe key, canonical URL, provisional metadata, and the source cursor that yielded it. Add `normalizePublishedAt` to `src/ingest/feed-parser.ts`.

- [ ] **Step 1: Write failing parser and URL tests** for normal/encoded/private URLs, multi-hop and cross-host redirects, oversized response, valid RSS/Atom/JSON Feed, >100 feed entries paged through to the end, duplicate IDs and duplicate URLs spanning page boundaries, >100 sitemap entries, sitemap index, missing HTML selector, normalized UTC timestamp, invalid timestamp → `null`, and >64-byte input.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement URL validation, manual redirect fetch, bounded feed/sitemap parsers, and selector-based HTML extraction.** Disable XML entity expansion and reject parser payloads exceeding caps.
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.**
- [ ] **Step 5: Run typecheck/build; commit `feat: add bounded source parsers and safe fetch`.**

### Task 4: Durable discovery backlog and cursor management

**Files:**
- Create: `src/ingest/pending-repository.ts`, `src/ingest/discovery.ts`, `src/ingest/storage-guard.ts`
- Modify: `src/ingest/feed-parser.ts`, `src/ingest/sitemap-parser.ts`, `src/ingest/types.ts`, `migrations/0001_initial.sql`
- Test: `tests/pending-repository.test.ts`, `tests/discovery.test.ts`, `tests/feed-parser.test.ts`, `tests/sitemap-parser.test.ts`, `tests/migrations.test.ts`, `tests/storage-guard.test.ts`

**Interfaces:**
- `enqueueCandidates(db: D1Database, source: Source, candidates: Candidate[], budget: PendingBudget): Promise<EnqueueResult>` atomically persists no more than 10 rows, 2,000 total rows, or 24 MiB serialized pending metadata and returns the last safely accounted cursor (newly persisted or already present via dedupe).
- Shared `checkWriteGate(db, writeKind, estimatedBytes)` measures D1 `meta.size_after` and creates an expiring reservation against the 280 MiB stop/300 MiB hard cap; `completeWriteReservation` records post-write `meta.size_after` and releases it. Task 5 reuses this API for `article`, `source`, and `run` writers and adds the global lease.
- `claimPending(db: D1Database, now: number, leaseToken: string): Promise<PendingItem | null>` claims the oldest eligible pending row.
- `markPendingFailure(db: D1Database, item: PendingItem, outcome: PendingFailure): Promise<void>` records bounded retryable or terminal failure state without dropping a candidate.
- `discoverSource` attaches the source ID, passes the last safely accounted feed cursor to `parseFeed`, stores same-host candidates, records safe cross-host URLs as terminal `blocked_external_host`, and persists unsafe parser entries as bounded terminal `blocked_unsafe_url` rows without raw unsafe URL data. Parser results expose rejected counts. Cursor advancement requires persistence/dedupe; if capacity blocks persistence, hold the cursor. Missing feed cursors restart from page one and rely on dedupe; valid cursors reset only after an empty parse page.
- Examine at most 25 candidates (including duplicates) per invocation so candidate-level batches plus gate queries remain below D1 Free's 50-query invocation limit; resume from the last accounted cursor.

- [ ] **Step 1: Write failing tests** for >10 candidates, >100 feed pagination across storage invocations, missing-cursor restart/dedupe, empty-page-only feed cursor reset, cross-host and unsafe terminal outcomes, no raw unsafe URL persistence, physical-size observation and 280/300 MiB gates/reservations, the ≤50 query/batch budget with duplicate-heavy pagination, oversized metadata, pending caps, cursor advancement only after persistence/dedupe, hold-on-capacity-failure, overlap dedupe, and terminal expiry.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement the shared measured-size reservation gate and pending path, expose rejected parser entries, and implement discovery persistence with metadata caps, same-host validation, cursor resume/reset, pending-cap accounting, ≤25 candidate checks per invocation, atomic pending/cursor writes, and terminal cleanup.** Keep retryable rows; retain terminal `blocked/failed` rows for 30 days. Task 5 extends the same gate to article/source/run writes under the global lease; article completion remains Task 5's responsibility.
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.**
- [ ] **Step 5: Run typecheck/build; commit `feat: persist discovery backlog and cursors`.**

### Task 5: Scheduled ingestion, article storage, and D1 write gate

**Files:**
- Create: `src/ingest/scheduler.ts`, `src/ingest/article-store.ts`, `src/ingest/fetch-source.ts`, `src/articles/types.ts`
- Modify: `src/ingest/storage-guard.ts`
- Modify: `src/index.ts`, `src/env.ts`, `wrangler.jsonc`, `src/ingest/pending-repository.ts`, `src/routes/sources.ts`
- Test: `tests/scheduler.test.ts`, `tests/article-store.test.ts`, `tests/storage-guard.test.ts`

**Interfaces:**
- `runScheduled(env: Env, scheduledTime: number): Promise<ScheduleResult>` processes one due source and at most two pending article URLs; it respects one global lease. Execution wall-clock time (`Date.now()`) governs eligibility, lease expiry, cleanup, status updates and retries; `scheduledTime` is reporting-only.
- A configured top-level sitemap document keeps its cursor in `sources.sitemap_last_loc`; each pending child URL-set keeps its independent `sitemap_cursor`, updated only after successful persistence/dedupe under the child's active lease.
- `discoverHtmlList(db, source, body, budget)` resolves `itemLink` hrefs against the listing URL, enforces public/same-host URL policy, and sends redacted unsafe/cross-host terminal candidates through the bounded pending write path.
- `checkWriteGate(db: D1Database, writeKind: 'pending' | 'article' | 'source' | 'run', estimatedBytes: number): Promise<WriteReservation | 'storage_limit'>` uses `meta.size_after`, reserves estimated growth against concurrent gated writes, stops at 280 MiB and enters read-only growth mode by 300 MiB; writers release reservations after writes with the actual `meta.size_after`.
- `Article` and `ArticleInput` are defined in `src/articles/types.ts`; `saveArticleAndCompletePending(db: D1Database, item: PendingItem, article: ArticleInput): Promise<SaveArticleResult>` calls `normalizePublishedAt` from Task 3, applies field caps including the 64-byte timestamp cap, combined-row cap 1,800,000 bytes, D1 unique constraints, FTS update, dedupe, and pending deletion in one D1 transaction.
- `leaseToken` must match before committing fetched results; expired global/pending leases may be reclaimed.
- `runScheduled` checks `system_state.export_lock` before any discovery or write. The source POST route calls `checkWriteGate(..., 'source', bytes)` before inserting; it rejects additions while ingestion is paused or storage-limited.

- [ ] **Step 1: Write failing tests** for scheduled source selection, feed/sitemap and html_list discovery, independent multi-child sitemap cursors with >10 URLs per child, delayed Cron delivery using execution wall-clock, max one source + two article fetches, backlog priority, retry/backoff, `Retry-After`, concurrent Cron lease, `blocked` status, article limits, pending completion atomicity, and sustained D1 overload.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Extend the Task 4 storage gate to article/source/run writes, then implement scheduler, global lease, full-text article fetch, list-page link discovery, per-child sitemap cursors, D1 transactional persistence, row/index caps, and fetch-run logging.** Use `Date.now()` for scheduling state, reject new sources and discovery at the gate, and allow only read/export/disable/delete operations when storage or export locks require it.
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.** Add a stress fixture proving D1 physical size remains under 300 MiB and no cursor passes an unpersisted item under sustained overload.
- [ ] **Step 5: Run typecheck/build; commit `feat: ingest feeds and store bounded full text`.**

### Task 6: Article REST API, FTS, and stable cursors

**Files:**
- Create: `src/routes/articles.ts`, `src/articles/repository.ts`, `src/articles/cursor.ts`
- Modify: `src/app.ts`
- Test: `tests/articles-api.test.ts`, `tests/articles-cursor.test.ts`, `tests/articles-repository.test.ts`

**Interfaces:**
- `listArticles(db: D1Database, query: ArticleQuery): Promise<ArticlePage>` uses `published_at DESC NULLS LAST, fetched_at DESC, id DESC` and a stable cursor tuple.
- `getArticle(db: D1Database, id: string): Promise<Article | null>` returns the `Article` type from `src/articles/types.ts` with complete stored text.
- `ArticleQuery` supports `source_id`, UTC `from` inclusive, `to` exclusive, `q` on title/snippet, opaque `cursor`, and `limit` 1–100.

- [ ] **Step 1: Write failing tests** for pagination boundaries/ties, invalid cursors, date semantics, per-source filtering, FTS title/snippet search, no body in list, full body in detail, not-found, and error JSON shape.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement indexed D1 queries, stable opaque cursors, list/detail routes, and canonical API errors.**
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.**
- [ ] **Step 5: Run typecheck/build; commit `feat: add article search and detail api`.**

### Task 7: Consistent export, restore, and operating guide

**Files:**
- Create: `src/exports/repository.ts`, `src/routes/exports.ts`, `scripts/restore-export.ts`, `docs/operations.md`, `tests/exports-api.test.ts`, `tests/exports-restore.test.ts`
- Modify: `src/app.ts`, `src/routes/sources.ts`

**Interfaces:**
- `startExport(db: D1Database, now: number): Promise<ExportSession>` locks ingestion and source configuration for up to 30 minutes.
- `getExportPage(db: D1Database, session: ExportSession, cursor: string | null): Promise<ExportPage>` includes schema version, sources, watermarks, all pending/retryable and retained terminal items, and articles/full text; max 10 records and max 3 MiB serialized UTF-8.
- `endExport(db: D1Database, sessionId: string): Promise<void>` releases the lock.
- Restore tooling replays export records into an empty local D1 and validates row counts/content hashes.

- [ ] **Step 1: Write failing tests** for export lock, ingestion/config lockout, 30-minute expiry, page row/byte caps with maximum body and pending records, cursor resumption, schema version, inclusion of pending/watermarks, and restore round-trip hashes.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement export snapshot/page API and local restore script; document Access setup on the custom hostname and ensure its policy protects both `/health` and `/v1/*`, D1 migration, local tests, D1 Time Travel, NDJSON export, recovery, and resource caps.**
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.**
- [ ] **Step 5: Run `npm run lint`, `npm run typecheck`, and `npm run build`; run full test suite; commit `feat: add consistent export and recovery guide`.**

---

After Task 7, run a whole-project spec/quality review against `docs/superpowers/specs/2026-11-16-media-aggregator-design.md`, then independently verify VCS diff and all test/build outputs. Do not deploy or create Cloudflare account resources; prepare instructions only.
