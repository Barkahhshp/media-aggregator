# Task 1 Report: Production Bearer Authentication

## Status

Implemented production Bearer authentication without Cloudflare Access or Zero Trust resources. No Worker secret was installed, no remote migration was run, and no deployment was performed.

## Changes

- `src/auth/local-token.ts`: production now requires a non-empty configured `API_TOKEN` and accepts only an exact `Authorization: Bearer <token>` value. Missing, empty, malformed, wrong, and absent production configuration fail closed with generic `401` responses. The limiter key is `${APP_ENV}:${SHA-256(authenticated token)}` and is derived from the same token that was authenticated. Raw tokens are not returned or logged.
- `src/app.ts`: `/health` is authenticated in production; `/v1/*` remains authenticated and rate-limited using the hashed key. `/health` is deliberately not rate-limited. Existing local/test behavior remains compatible, including the existing unauthenticated local/test health contract.
- `src/env.ts`: removed unused `ACCESS_AUD` configuration.
- `tests/auth.test.ts`: added production success, missing/wrong/malformed rejection, absent configuration fail-closed, raw-secret non-leak, and stable SHA-256 limiter identity coverage while retaining local/test coverage.
- `tests/sources-api.test.ts`: replaced native Access tests with production `/health` and `/v1/*` unauthorized/authorized route coverage and retained API behavior coverage.
- `docs/operations.md`: documents the encrypted Worker secret `API_TOKEN`, caller header `Authorization: Bearer <token>`, hashed limiter identity, and explicitly removes the Access/Zero Trust requirement.

## TDD evidence

The focused tests were run before production changes and failed for the expected reasons: configured production Bearer authentication was rejected by the old Access-only path, and production `/health` returned `200` without authentication. After the minimal implementation, the focused suite passed.

## Verification results

- `npm test -- tests/auth.test.ts tests/sources-api.test.ts`: PASS — 2 files, 28 tests.
- `npm test`: PASS — 23 files, 221 tests.
- `npm run lint`: PASS — exit code 0.
- `npm run typecheck`: PASS — exit code 0.
- `npm run build`: PASS — Wrangler dry-run only; exit code 0.
- `npm audit`: PASS — `found 0 vulnerabilities`.
- `git diff --check`: PASS — no output.

## Scope and safety review

Only the requested implementation, tests, documentation, and this report are staged for the commit. The pre-existing progress ledger and untracked proposal/design files are not included. No API token, secret reference, or secret value is present in the implementation, tests, report, or documentation.

## Remaining operational action

An authorized operator must configure the Worker secret `API_TOKEN` through the deployment workflow and deploy separately. This task intentionally does not perform that external side effect.

## Review fix

Rewrote the portable export example to use environment variable `API_TOKEN` and `Authorization: Bearer $API_TOKEN` through the shared headers array for every request, including cleanup; removed the obsolete caller instructions.

Checks run and actual output:

```text
$ grep -F 'Authorization: Bearer $API_TOKEN' docs/operations.md
HEADERS=(-H "Authorization: Bearer $API_TOKEN")
$ grep -nE 'CF-Access|CF_ACCESS|Access credentials|ACCESS_AUD|JWT' docs/operations.md
(no matches)
$ grep -n 'curl' docs/operations.md
47:Example machine export (requires `curl` and `jq`; keep `API_TOKEN` in the environment without printing it):
64:    curl -fsS -X DELETE "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" >/dev/null || true
72:SESSION=$(curl -fsS -X POST "${HEADERS[@]}" "$BASE_URL/v1/exports")
77:    curl -fsS "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" -o "$PAGE"
79:    curl -fsS -G "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" \
      --data-urlencode "cursor=$CURSOR" -o "$PAGE"
$ git diff --check
```
