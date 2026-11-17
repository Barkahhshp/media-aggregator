# Media Aggregator Operations Guide

## Protect the custom hostname with Cloudflare Access

Create a Cloudflare Access **Self-hosted** application for the API's custom hostname. Add protected paths for both `/health` and `/v1/*` and attach the intended policy to each path. Do not assume one path rule protects the other: Access evaluates the most-specific application path, and a wildcard such as `/v1/*` does not cover `/v1` or `/health`. A full-host policy is another option when every route should use the same controls. See Cloudflare's [application path rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) and [self-hosted application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

For machine access, use a **Service Auth** policy and a Cloudflare Access service token. Send `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the Access edge; store both values as secrets, rotate them when needed, and do not put them in logs or backup files. Access checks the request and injects the native Worker Access context. The Worker requires that context for `/v1/*` in production, verifies its `aud` against the owner-supplied `ACCESS_AUD` variable, requires a service-token identity with `service_token_status: true`, and hashes its `service_token_id` before calling the configured `RATE_LIMITER` binding. It does not trust a request header or decode an assertion itself. The default is 120 requests per 60 seconds per service token, per Cloudflare location. Cloudflare's Worker Rate Limiting API is approximate and location-local, so counts may briefly exceed the limit and are not a strict global quota. The binding's `namespace_id` must be unique in the Cloudflare account before deployment; no remote namespace is created by this repository change. Local `/v1/*` requests instead use `Authorization: Bearer $API_TOKEN`; `/health` is not authenticated by the application itself, so the external Access path rule is what protects it in production. Read Cloudflare's [service-token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) and [Worker Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) before creating or rotating credentials.

### Worker-level Access setup

At the Worker level, configure a Cloudflare Access **Self-hosted** application for the API hostname and attach a **Service Auth** policy to `/v1/*` (and to `/health` when the health endpoint must also be protected). Every production and preview Worker hostname, route, or domain intended to be protected must be covered by Worker-level Access; do not assume coverage transfers between those endpoints. Create the service token in the Cloudflare dashboard, provide its client ID and secret to callers as secrets, and set `ACCESS_AUD` to the audience value for the Access application. `ACCESS_AUD` is owner-supplied configuration: this repository does not infer it, create it, or change any Cloudflare resource. Verify the application path rules and policy independently before deployment.

`GET /v1/status` reports active and disabled pending counts, the age of the oldest retained pending item, and the latest measured D1 size/storage state. `GET /v1/sources` includes each source's `pending_count` and `oldest_pending_at`. Disabling a source retains its backlog, marks it `disabled_source`, and keeps it out of fetch claims; enable it again when you want that backlog to resume. Keep both status endpoints behind the same Access policy as the rest of `/v1/*`.

## Migrations and local checks

Wrangler local D1 uses a separate local database, not the production database. Apply migrations locally and run the checks before considering any production change:

```bash
npx wrangler d1 migrations list media-aggregator --local
npx wrangler d1 migrations apply media-aggregator --local
npm test
npm run lint
npm run typecheck
npm run build
```

`npm run build` is configured as a Wrangler dry run and does not publish the Worker. For a later, deliberate production migration, review the active Wrangler environment and database binding first, then use `npx wrangler d1 migrations apply media-aggregator --remote` only with the appropriate account authorization and change approval. Wrangler stores versioned SQL migration files under `migrations/`; see Cloudflare's [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [local development](https://developers.cloudflare.com/d1/best-practices/local-development/) guides.

## D1 Time Travel

For the production D1 backend, Time Travel is always on; no separate backup job needs to be configured. To inspect the current bookmark or look up a point in time, use:

```bash
npx wrangler d1 time-travel info media-aggregator
npx wrangler d1 time-travel info media-aggregator --timestamp="2026-11-16T12:00:00Z"
```

After independently confirming the target database and timestamp, restore with:

```bash
npx wrangler d1 time-travel restore media-aggregator --timestamp="2026-11-16T12:00:00Z"
```

This overwrites the database at the selected point in time and cancels in-flight queries; Wrangler asks for confirmation. After a restore, inspect application health, migration state, source watermarks and article/search results. Free accounts retain seven days of history; Paid accounts retain 30 days. Time Travel is not a substitute for a portable export: see Cloudflare's [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Portable NDJSON export and local restore

An export is a stable snapshot. Starting one waits until an active ingestion lease has finished, takes the existing `system_state.export_lock` for up to 30 minutes, and blocks scheduler and source changes until `endExport` releases it. Every page repeats a schema-versioned manifest and contains at most 10 NDJSON lines total (manifest included) and 3 MiB of UTF-8 output. Full article text is encoded as base64 UTF-8 so one maximum-size article remains representable; the restore tool decodes it and verifies its SHA-256 content hash. The manifest reports the stable snapshot ID, export watermark, row counts, and next cursor. Page through the cursor in order, keep the file private, and always end the session when finished. If the lock expires, start a fresh export rather than mixing pages from different snapshots.

Example machine export (requires `curl` and `jq`; keep the Access credentials in environment variables):

```bash
set -euo pipefail
umask 077
BASE_URL="https://api.example.com"
HEADERS=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
         -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
BACKUP="media-aggregator-$(date -u +%Y%m%dT%H%M%SZ).ndjson"
if [ -e "$BACKUP" ]; then
  printf 'Refusing to overwrite existing backup %s\n' "$BACKUP" >&2
  exit 1
fi
PAGE=$(mktemp)
BACKUP_TMP=$(mktemp "${BACKUP}.tmp.XXXXXX")
EXPORT_ID=""
cleanup() {
  if [ -n "${EXPORT_ID:-}" ]; then
    curl -fsS -X DELETE "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" >/dev/null || true
  fi
  rm -f "$PAGE"
  if [ -n "${BACKUP_TMP:-}" ]; then
    rm -f "$BACKUP_TMP"
  fi
}
trap cleanup EXIT
SESSION=$(curl -fsS -X POST "${HEADERS[@]}" "$BASE_URL/v1/exports")
EXPORT_ID=$(printf '%s' "$SESSION" | jq -r '.session.id')
CURSOR=""
while :; do
  if [ -z "$CURSOR" ]; then
    curl -fsS "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" -o "$PAGE"
  else
    curl -fsS -G "${HEADERS[@]}" "$BASE_URL/v1/exports/$EXPORT_ID" \
      --data-urlencode "cursor=$CURSOR" -o "$PAGE"
  fi
  cat "$PAGE" >> "$BACKUP_TMP"
  CURSOR=$(head -n 1 "$PAGE" | jq -r '.next_cursor // empty')
  [ -n "$CURSOR" ] || break
done
# Atomic no-clobber publication: fails if a backup with the same timestamp exists.
ln "$BACKUP_TMP" "$BACKUP"
rm "$BACKUP_TMP"
BACKUP_TMP=""
printf 'Private backup saved as %s\n' "$BACKUP"
```

The export includes source configuration and state (including feed/sitemap watermarks and fetch validators), every pending/retryable row and retained terminal row, and article metadata plus full text. The restore rebuilds the article full-text index. Ephemeral export/global-ingestion locks, write reservations, and `fetch_runs` are not restored.

To restore into an **empty local D1** database after keeping the NDJSON file private and available:

```bash
npm run restore:export -- "$BACKUP"
```

The command applies configured migrations with `--local`, opens the Wrangler local D1 binding with remote bindings disabled, refuses a populated target, restores rows with parameterized D1 writes, checks manifest row counts, and reads every restored article in small batches. It verifies the SHA-256 of each retained body; for `content_too_large` with an empty stored body, it preserves the source-body hash and validates the explicit status/empty-body case because the original oversized bytes are absent from the backup. It never selects a remote D1 binding. If restoration fails partway through, recreate or clear the local D1 database before retrying; do not append a second restore to a partially restored database.

For a disposable local database separate from the default Wrangler state, set `D1_LOCAL_PERSIST` to a local directory, for example: `D1_LOCAL_PERSIST=/tmp/media-aggregator-restore npm run restore:export -- "$BACKUP"`.

## Resource caps and operational behavior

The export contract is **10 lines and 3 MiB per page**, with the manifest counting as one line. The export lock lasts 30 minutes. Only one active session is allowed; completed and stale session rows are removed on end/restart/expiry, and a new session must pass the shared D1 storage gate. Full article text is capped by the schema at 512,000 UTF-8 bytes per article; page size is checked after encoding and serialization, so page lengths vary with metadata and text. For `content_too_large`, the stored/exported full text is empty while `content_hash` remains the SHA-256 of the fetched oversized body; restore preserves that hash and validates the status/empty-body exception, since the discarded body cannot be rehashed from the backup.

This project starts blocking storage-growing writes at 280 MiB and defines a 300 MiB hard cap (`src/ingest/storage-guard.ts`), below Cloudflare D1's 500 MB per-database Free limit. Cloudflare currently documents a 5 GB Free account storage cap, 50 D1 queries per Worker invocation on Free, 2,000,000 bytes maximum for a row, and 50 MB maximum for a query result. Starting September 1, 2026, Free-plan D1 also enforces daily row-read/write quotas and resets exceeded limits at midnight UTC; see the [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [daily quota enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

Workers Free currently allows 100,000 requests per day, 10 ms CPU per HTTP/Cron invocation, and 50 subrequests per invocation. The local throughput fixture measures elapsed time for parsing a 100-item feed and persisting it through ten 10-row D1 batches under the Workers test runtime; local elapsed time includes D1 overhead and is not the same as billed CPU time. Production CPU behavior against the 10 ms budget remains unverified because no deployment is part of this work. Keep exports paginated, limit concurrent exports to the single existing lock, and avoid doing large export/restore work inside an ingestion or request path. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before increasing caps or moving to a different plan.

No Cloudflare account resource was created and nothing was deployed for this task.
