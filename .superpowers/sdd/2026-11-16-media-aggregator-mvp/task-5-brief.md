### Task 5: Scheduled ingestion, article storage, and D1 write gate

**Files:**
- Create: `src/ingest/scheduler.ts`, `src/ingest/article-store.ts`, `src/ingest/fetch-source.ts`, `src/articles/types.ts`
- Modify: `src/ingest/storage-guard.ts`
- Modify: `src/index.ts`, `src/env.ts`, `wrangler.jsonc`, `src/ingest/pending-repository.ts`, `src/routes/sources.ts`
- Test: `tests/scheduler.test.ts`, `tests/article-store.test.ts`, `tests/storage-guard.test.ts`

**Interfaces:**
- `runScheduled(env: Env, scheduledTime: number): Promise<ScheduleResult>` processes one source and at most two pending article URLs; it respects one global lease.
- `checkWriteGate(db: D1Database, writeKind: 'pending' | 'article' | 'source' | 'run', estimatedBytes: number): Promise<WriteReservation | 'storage_limit'>` uses `meta.size_after`, reserves estimated growth against concurrent gated writes, stops at 280 MiB and enters read-only growth mode by 300 MiB; writers release reservations after writes with the actual `meta.size_after`.
- `Article` and `ArticleInput` are defined in `src/articles/types.ts`; `saveArticleAndCompletePending(db: D1Database, item: PendingItem, article: ArticleInput): Promise<SaveArticleResult>` calls `normalizePublishedAt` from Task 3, applies field caps including the 64-byte timestamp cap, combined-row cap 1,800,000 bytes, D1 unique constraints, FTS update, dedupe, and pending deletion in one D1 transaction.
- `leaseToken` must match before committing fetched results; expired global/pending leases may be reclaimed.
- A sitemap URL-set child stores its own bounded `sitemap_cursor` on its `pending_items` row; keep the top-level source cursor separate and condition child-cursor advancement on successful persistence/dedupe under the active lease.
- `html_list` requires `selectors.itemLink` for list-page link extraction; retain article `title`/`body` selectors for fetched links, resolve relative `href` values against the list URL, enforce public same-host policy, and persist unsafe/external links only as bounded, redacted terminal outcomes.
- Use execution wall-clock (`Date.now()`) for due-source eligibility, global/pending lease expiry, retries, cleanup, and state timestamps; `scheduledTime` may be used for run reporting only.
- `runScheduled` checks `system_state.export_lock` before any discovery or write. The source POST route calls `checkWriteGate(..., 'source', bytes)` before inserting; it rejects additions while ingestion is paused or storage-limited.

- [ ] **Step 1: Write failing tests** for scheduled source selection, feed/sitemap and html_list discovery, independent cursors for multiple sitemap children each exceeding 10 URLs, delayed Cron delivery using execution wall-clock, max one source + two article fetches, backlog priority, retry/backoff, `Retry-After`, concurrent Cron lease, `blocked` status, article limits, pending completion atomicity, and sustained D1 overload.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Extend the Task 4 storage gate to article/source/run writes, then implement scheduler, global lease, full-text article fetch, D1 transactional persistence, row/index caps, and fetch-run logging.** Reject new sources and discovery at the gate; allow only read/export/disable/delete operations.
- [ ] **Step 4: Run focused tests and full `npm test`; verify GREEN.** Add a stress fixture proving D1 physical size remains under 300 MiB and no cursor passes an unpersisted item under sustained overload.
- [ ] **Step 5: Run typecheck/build; commit `feat: ingest feeds and store bounded full text`.**
