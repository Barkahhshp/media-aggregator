# Task 13 implementer report — Exports/Backups screen

**Status:** DONE

**Base:** `e054221b97dcbd8957fdc5b8abe62e1b5a2cbd27`

**Commit:** `f73f50584e7bde14229ba8d9f0627c121704dfc3` — `feat(dashboard): add exports and backup downloads`

## Implementation

Added the Exports and Backups navigation route and responsive page. The page warns that the temporary export lock pauses scheduled ingestion and blocks source changes, requires an explicit start action, displays active snapshot ID/counts/expiry and progress, checks for an active lock after reload, and recovers that snapshot from page one rather than trusting its prior cursor. It prefers browser incremental file writing; when unavailable, it builds a Blob and warns that large downloads consume browser memory. It attempts `DELETE /v1/exports/:id` after success and transfer failure, shows cleanup uncertainty and expiry, and does not expose remote restore, archival-retention, or whole-backup-checksum claims. Local CLI restore remains the only restore path.

Added an export client that validates NDJSON manifests and snapshot identity/count consistency page by page, follows opaque cursors while rejecting loops, verifies final record counts, tracks progress, closes or aborts the writer, and always attempts server-session cleanup after a transfer has started. The API token remains outside the export client and NDJSON/output filename path; it is only supplied by the existing API client's Authorization header.

## Test-first evidence

The focused tests first failed because the export client and page modules did not exist. A later failure-state regression test was run RED against the implementation and exposed fabricated zero counts when a newly started session could not be read back. The page now marks counts unavailable, shows the snapshot expiry and cleanup outcome, offers a status retry, and attempts DELETE. The focused tests then passed.

## Verification

- `npm run test:dashboard -- tests/export-client.test.ts tests/exports-page.test.tsx`: 15 passed.
- `npm run test:dashboard`: 63 tests passed across 13 files.
- `npm test`: 272 tests passed across 31 files. The physical D1 fill test uses `cloudflare:test` with `reset()` and `applyD1Migrations()` in its isolated test binding; no Wrangler development D1 migration/reset command was run.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run typecheck:dashboard`: passed.
- `npm run build`: dashboard production build succeeded; Wrangler `deploy --dry-run` exited without deploying.
- `git diff --check`: passed.

Only the six Task 13 files were staged and committed. The pre-existing modified MVP progress file and untracked bearer/access plan/design documents were not staged or edited. No push, deploy, remote migration, or Cloudflare resource change was performed.

## Fix round 1 evidence

Addressed the reviewer finding that malformed or failed POST responses could leave a server-side export lock without cleanup. Start failures now classify the response: malformed/truncated successful responses and non-423 POST failures probe `/v1/exports/active` and DELETE the recovered session ID when present; a rejected concurrent `423` start is not probed or deleted because its active session belongs to another tab. The original start error is preserved. If recovery or DELETE cannot be confirmed, the UI reports the uncertainty, includes the recovered expiry when available, and documents the safe-correlation boundary when no active session can be identified.

Added focused regressions for malformed `201` response recovery/DELETE and rejected concurrent start non-cancellation.

- `npm run test:dashboard -- tests/exports-page.test.tsx`: 8 tests passed.
- `npm run typecheck:dashboard`: passed.
- `npm run lint -- --quiet`: passed.
