# Native Cloudflare Access authentication — Task 1 report

## Scope and implementation

Implemented Task 1 on branch `feature/media-aggregator-mvp` from base commit `4368ce58c7654aa2330ed45cb1d0b520ee0e0969`.

Production `/v1/*` authentication now reads only the native Hono/Worker execution context (`executionCtx.access`), verifies the configured audience, requires `service_token_status === true` and a nonblank `service_token_id`, and hashes only that identity for the rate-limit key. Missing/blank `ACCESS_AUD`, missing context, audience mismatch, absent/user identity, missing/blank service-token ID, and identity lookup errors fail closed before the limiter. Local/test Bearer authentication remains unchanged. Operations documentation now describes Worker-level Access, the Service Auth policy, and owner-supplied `ACCESS_AUD`; no remote Cloudflare setup or deployment was performed.

## TDD RED

Tests were added before production implementation. Exact command:

```text
npm test -- tests/auth.test.ts tests/sources-api.test.ts
```

Observed output against the original header-presence/unverified-decode behavior:

```text
FAIL tests/auth.test.ts > local authentication > rejects_production_authentication_without_native_access_context
AssertionError: expected null not to be null

FAIL tests/sources-api.test.ts > source management API > authenticates_verified_service_tokens_and_rate_limits_each_identity_separately
AssertionError: expected 401 to be 200

Test Files  2 failed (2)
Tests       2 failed | 31 passed (33)
```

The RED failures were the intended failures: a forged nonempty `Cf-Access-Jwt-Assertion` was accepted, and native verified service-token context was not accepted by the old implementation. The rejection cases already passed against the old behavior; they cover no native context despite forged headers, missing/wrong audience, absent identity, user identity without service-token status, missing/blank service-token ID, identity lookup throwing, limiter non-invocation, and no response echo of auth material. The existing local Bearer tests remained green.

## TDD GREEN

Exact focused command after the minimal implementation:

```text
npm test -- tests/auth.test.ts tests/sources-api.test.ts
```

Exact successful result:

```text
✓ tests/auth.test.ts (5 tests)
✓ tests/sources-api.test.ts (28 tests)
Test Files  2 passed (2)
Tests       33 passed (33)
```

The native acceptance regression verifies `aud="expected-aud"`, `service_token_id="service-a.access"`, and `service_token_status=true` reach the route and limiter. A second verified identity produces a distinct hashed limiter key, and neither raw ID appears in the key. Every rejection asserts HTTP 401 and zero limiter calls.

## Focused verification

- `npm test -- tests/auth.test.ts tests/sources-api.test.ts` — PASS; 2 files, 33 tests.
- `npm run typecheck` — PASS; `tsc --noEmit` exit 0.

## Full verification

Commands were run exactly as requested:

```text
npm test
```

```text
Test Files  23 passed (23)
Tests       226 passed (226)
EXIT_STATUS=0
```

```text
npm run lint
> lint
> eslint .
EXIT_STATUS=0
```

```text
npm run typecheck
> typecheck
> tsc --noEmit
EXIT_STATUS=0
```

```text
npm run build
> build
> wrangler deploy --dry-run --outdir dist --env ""
--dry-run: exiting now.
EXIT_STATUS=0
```

The build reported the expected local bindings and performed no deployment.

```text
npm audit
found 0 vulnerabilities
EXIT_STATUS=0
```

```text
git diff --check
EXIT_STATUS=0
```

## Files changed for this task

- `src/auth/local-token.ts`
- `src/app.ts`
- `src/env.ts`
- `docs/operations.md`
- `tests/auth.test.ts`
- `tests/sources-api.test.ts`
- `.superpowers/sdd/2026-11-17-cloudflare-access-native/access-report.md`

The pre-existing coordinator-only modification `.superpowers/sdd/2026-11-16-media-aggregator-mvp/progress.md` and untracked plan/spec files under `docs/superpowers/` were preserved and were not staged.

## Concerns and review state

No Cloudflare account/resource/policy/token/secret changes were made, and nothing was deployed or pushed. A fresh independent reviewer reviewed commit `52efda8` and raised the native identity double-lookup finding addressed below. The scoped fix remains unpushed; parent/coordinator review remains required before any future push.

## Independent review and fix round 1

The fresh independent review found that production middleware called native `getIdentity()` once during `authenticateLocal(...)` and again during `rateLimitKey(...)`. This could authorize one service-token identity while rate-limiting another, or authorize successfully and fail during key derivation, and duplicated a platform lookup. The fix performs authentication and SHA-256 key derivation in one helper, passes only the resulting hash to `RATE_LIMITER.limit`, and preserves local Bearer validation behavior. The regression uses a real Hono request whose first lookup returns `authenticated.access` and second lookup would return `different.access`; it asserts one lookup and the first identity's hash.

### RED

Exact command:

```text
npm test -- tests/sources-api.test.ts -t uses_the_authenticated_native_identity_for_rate_limiting_without_a_second_lookup
```

Relevant exact output:

```text
FAIL tests/sources-api.test.ts > source management API > uses_the_authenticated_native_identity_for_rate_limiting_without_a_second_lookup
AssertionError: expected 2 to be 1 // Object.is equality
Tests  1 failed | 28 skipped (29)
```

### GREEN

Exact focused command:

```text
npm test -- tests/sources-api.test.ts -t uses_the_authenticated_native_identity_for_rate_limiting_without_a_second_lookup
```

Exact result:

```text
Test Files  1 passed (1)
Tests       1 passed | 28 skipped (29)
```

Relevant auth/API verification command:

```text
npm test -- tests/auth.test.ts tests/sources-api.test.ts
```

Exact result:

```text
Test Files  2 passed (2)
Tests       34 passed (34)
```

Additional verification:

```text
npm run typecheck
> tsc --noEmit

git diff --check
```

Both commands exited 0. Affected files are `src/auth/local-token.ts`, `src/app.ts`, `tests/sources-api.test.ts`, and this report. The fix commit SHA is recorded after commit creation below.

Fix commit: `69be0202a60e41279f4d6ebd01fe67588584c0c6` — `fix: use authenticated native identity for rate limiting`


## Final verification after the identity fix

The full checks were rerun at `ab30bb3`, with code state through `69be020`. Subsequent commits `ab30bb3` and `8750025` were report-only, so no code changed after those checks. The reviewed HEAD is `8750025`.

- `npm test` — PASS; 23 test files, 227 tests passed, exit 0.
- `npm run lint` — PASS; `eslint .`, exit 0.
- `npm run typecheck` — PASS; `tsc --noEmit`, exit 0.
- `npm run build` — PASS; Wrangler dry-run completed and exited 0; no deployment occurred.
- `npm audit` — PASS; 0 vulnerabilities, exit 0.
- `git diff --check` — PASS; exit 0.

## Final review polish

The final review polish made three clarification-only changes: corrected the test-side `authenticateLocal` declaration to `Promise<Response | null>` to match the async implementation; clarified that every production and preview Worker hostname, route, or domain intended to be protected must be covered by Worker-level Access; and corrected the final verification metadata to state that the full-suite checks ran at `ab30bb3`, with code state through `69be020`, while `ab30bb3` and `8750025` were report-only commits, so no code changed after those checks.

Commands and outputs for this fix wave:

```text
npm test -- tests/auth.test.ts — PASS; 1 test file, 5 tests passed, exit 0.
npm run typecheck — PASS; tsc --noEmit, exit 0.
git diff --check — PASS; exit 0.
```

Fix-wave commit SHA: `b416d20` — `docs: polish native Access review findings`.
