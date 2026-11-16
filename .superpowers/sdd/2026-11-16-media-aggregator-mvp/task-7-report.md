# Task 7 Report — Consistent Export, Restore, and Operations Guide

The requested report file did not exist when inspected, so it was created here with the requested evidence.

## TDD evidence

The new export/restore tests were written before production implementation. The first focused RED command was:

```text
npm test -- tests/exports-api.test.ts tests/exports-restore.test.ts
```

Observed: `Test Files 2 failed (2); Tests 9 failed (9)`. The export start endpoint returned 404 instead of 201 because the route was not mounted, and restore/repository module loaders were undefined because those modules did not yet exist. Raw output: `task-7-red.log`.

The source-lock regression was then run before changing the source handlers/repository:

```text
npm test -- tests/sources-api.test.ts -t blocks_all_source_mutations_during_export
```

Observed: `Test Files 1 failed (1); Tests 1 failed | 14 skipped`; the disable PATCH returned 200 rather than the required 423 during an export lock. Raw output: `task-7-source-lock-red.log`.

The first GREEN attempt exposed a test-fixture issue: its tamper test replaced plaintext while exported full text is base64-encoded. The test was corrected to mutate the encoded bytes. The final focused run was:

```text
npm test -- tests/exports-api.test.ts tests/exports-restore.test.ts tests/sources-api.test.ts
```

Observed: `Test Files 3 passed (3); Tests 24 passed (24)`. Raw output: `task-7-focused-green-final.log`.

## Implementation

Added the paginated schema-v1 NDJSON export API using Task 5's existing `system_state.export_lock` and expiry. It locks ingestion/source configuration for 30 minutes, snapshots source state and watermarks, all pending/retryable and retained terminal rows, and article metadata plus full text. Cursors resume within one snapshot; each page is capped at 10 total records including its manifest and 3 MiB UTF-8. `DELETE /v1/exports/:id` calls `endExport` and releases the same lock. Source update, disable, and delete writes are rejected during the active lock.

Added a local-only restore CLI. It validates schema and row counts, refuses a populated target, restores via bound D1 writes, rebuilds FTS rows, and verifies each article's SHA-256 after restore. The CLI uses Wrangler migrations with `--local` and a local proxy with remote bindings disabled. Added the operations guide and the lint/typecheck/restore commands.

## Final verification

```text
npm test
Test Files 22 passed (22)
Tests 205 passed (205)
Physical D1 test: LOCAL_D1_PHYSICAL_SIZE_AFTER=295215104; STOP_BYTES=293601280

npm run lint
Passed (exit 0).

npm run typecheck
Passed (exit 0; includes scripts/restore-export.ts).

npm run build
Wrangler dry run passed; Total Upload: 292.21 KiB / gzip: 63.73 KiB; --dry-run exited.

npm audit
found 0 vulnerabilities

git diff --cached --check
Passed.
```

`npm run lint` is intentionally scoped to the Task 7 changed source, CLI, and tests because this repository had no prior lint command. A broader `eslint .` attempt found five existing findings in unchanged files (`src/articles/repository.ts`, `tests/articles-repository.test.ts`, `tests/discovery.test.ts`, and `tests/storage-physical-fill.test.ts`); those unrelated files were not modified.

Local CLI smoke test:

```text
D1_LOCAL_PERSIST=/tmp/task7-restore-smoke-state npm run restore:export -- /tmp/task7-restore-smoke.ndjson
{"status":"restored","counts":{"sources":1,"pending_items":0,"articles":1},"verified_article_hashes":1}
```

A follow-up `wrangler d1 execute ... --local` query returned `sources=1`, `pending_items=0`, `articles=1`, `articles_fts=1`. This smoke used only the isolated local persistence path.

## Deployment and commit

No Cloudflare account resource was created and nothing was deployed. The requested commit message is `feat: add consistent export and recovery guide`.
