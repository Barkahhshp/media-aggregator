# Task 6 report — Separate run and pending errors; safe pending drill-down

## Changed files

- `src/ops/errors-repository.ts`
- `src/routes/errors.ts`
- `src/routes/pending.ts`
- `src/app.ts`
- `tests/ops-errors-api.test.ts`
- `tests/pending-api.test.ts`

The app registration adds the two read-only routes while preserving the existing `/v1/*` authentication, rate limiting, and `Cache-Control: no-store` middleware unchanged.

## Behavior delivered

- `GET /v1/errors` aggregates run-source errors and pending-item errors as separate `origin` values, grouped by origin/source/code/status with count, first/last timestamps, and at most three sanitized samples.
- Legacy pending rows with a message and null `last_error_code` are represented as `unknown_error`.
- Error groups support source filtering, bounded limits (default 50, maximum 100), opaque cursor validation, and stable keyset pagination.
- `GET /v1/pending` supports only `pending`, `retry_wait`, `blocked`, and `failed`, defaults to 50 rows and caps at 100, excludes leased rows, supports source filtering and stable `(discovered_at, id)` keyset pagination, and exposes only the safe fields required by the brief.
- Pending messages and error codes use the established sanitizers; URLs, control characters, bearer/credential-like values, and overlong content are bounded/redacted. Internal lease, dedupe, canonical URL, sitemap cursor, and raw error fields are not returned.
- No mutation endpoints or `articles` reads were added.

## Verification

### RED

Command:

```text
npm test -- tests/ops-errors-api.test.ts tests/pending-api.test.ts
```

Initial fixture run failed on invalid test fixture constraints. After correcting only the fixtures, the same command produced the intended missing-behavior RED: all four tests failed because `/v1/errors` and `/v1/pending` were not registered (404 responses / invalid JSON), before implementation.

### GREEN

Command:

```text
npm test -- tests/ops-errors-api.test.ts tests/pending-api.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       4 passed (4)
```

### Typecheck

Command:

```text
npm run typecheck
```

Result: passed (`tsc --noEmit`, exit code 0).

### Additional checks

- `git diff --check`: passed.
- Focused tests assert authentication/no-store behavior, separate origins, aggregation bounds/samples, source filtering, all supported pending statuses, legacy unknown codes, cursor validation/consistency, sanitization, forbidden-field absence, bounded limits, query plans, and absence of `articles` references.
- Self-review found no changes to the protected progress file or unrelated docs/plans/specs. The commit was created with an explicit six-file `git add`.

## Commit

`564d18a400b27057bf102fd2b9e3b5a92d91d9e8` — `feat: add ops errors and pending APIs`

## Concerns or deviations

None. The working tree still contains the pre-existing protected modification and untracked docs/plans/specs; they were not edited, staged, cleaned, or overwritten. The report itself is the explicitly requested Task 6 artifact outside the six implementation/test files.

## Fix round 1

### Finding 1 — unsanitized `/v1/errors` codes

Added `normalizes unsafe error codes before grouping and returning them` in `tests/ops-errors-api.test.ts`. The test inserts credential-like and space-containing stored codes, then verifies that the API exposes one bounded `unknown_error` group with both rows and no unsafe grouping keys. The repository now normalizes `raw_code` in SQL before ranking/grouping: only trimmed lowercase codes matching the bounded safe-code grammar are retained; all other values become `unknown_error`. This ensures malformed variants cannot form separately exposed groups.

### Finding 2 — run-error retention was not enforced by the query

Added `does not expose run errors older than the 30-day retention window` in `tests/ops-errors-api.test.ts`. The run branch now explicitly requires `fetch_runs.started_at >= unixepoch() - (30 * 24 * 60 * 60)`. The predicate is run-only; pending errors remain unaffected by this retention condition.

### Verification

RED command:

```text
npm test -- tests/ops-errors-api.test.ts
```

RED result:

```text
Test Files  1 failed (1)
Tests       2 failed | 2 passed (4)
```

The normalization test failed because no `unknown_error` group was returned for the unsafe codes; the retention test failed because the old run was included with `count: 2`.

Focused GREEN command:

```text
npm test -- tests/ops-errors-api.test.ts
```

Focused GREEN result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Required two-file GREEN command:

```text
npm test -- tests/ops-errors-api.test.ts tests/pending-api.test.ts
```

Required two-file GREEN result:

```text
Test Files  2 passed (2)
Tests       6 passed (6)
```

Typecheck command:

```text
npm run typecheck
```

Typecheck result: passed (`tsc --noEmit`, exit code 0).

### Commit

Fix commit SHA: `c7f5901e06973e7c19acee735e9f051a6d4bc3a9`

### Deferred reviewer minors

The aggregation still processes eligible rows before page limit, and sample ranking still has no deterministic timestamp tie-breaker. Both were intentionally deferred to the ledger as instructed.
