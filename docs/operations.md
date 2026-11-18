# Media Aggregator Operations Guide

## Protect the API with a Worker Bearer secret

Production authentication uses one encrypted Cloudflare Worker secret named `API_TOKEN`; Cloudflare Access and Zero Trust are not required. Configure the secret through the normal, owner-authorized Worker secret workflow. Never commit, print, log, return, or place the token in backup files.

In production, callers must send the exact configured token in `Authorization: Bearer <token>` for both `GET /health` and every `/v1/*` route. Every `/v1/*` route also requires the configured token in local development; `/health` retains its existing unauthenticated local behavior. Missing, malformed, wrong, empty, or absent production configuration is rejected with a generic `401` response. The Worker hashes the accepted token with SHA-256 before calling the configured `RATE_LIMITER`; the raw token is never used as a limiter key. The existing default is 120 requests per 60 seconds per token, per Cloudflare location. Cloudflare's Worker Rate Limiting API is approximate and location-local, so counts may briefly exceed the limit and are not a strict global quota. No Cloudflare resource is created by this repository change.

`GET /v1/status` reports active and disabled pending counts, the age of the oldest retained pending item, and the latest measured D1 size/storage state. `GET /v1/sources` includes each source's `pending_count` and `oldest_pending_at`. Disabling a source retains its backlog, marks it `disabled_source`, and keeps it out of fetch claims; enable it again when you want that backlog to resume. Keep both status endpoints behind the same Bearer-token protection as the rest of `/v1/*`.

## Run the dashboard locally

The dashboard is built into `dashboard/dist/` and served as static assets by the same Worker that handles `/v1/*`; it does not use a separate API origin. Create a local-only `API_TOKEN` in the ignored `.dev.vars` file before starting the Worker. Do not copy a production credential into documentation, a URL, or the repository.

From the repository root, create a fresh local persistence directory, apply and list migrations against that local D1 only, build the dashboard, then start Wrangler in local mode:

```bash
LOCAL_STATE="$(mktemp -d)"
npx wrangler d1 migrations apply media-aggregator --local --persist-to "$LOCAL_STATE"
npx wrangler d1 migrations list media-aggregator --local --persist-to "$LOCAL_STATE"
npm run build:dashboard
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to "$LOCAL_STATE"
```

Open <http://127.0.0.1:8787>. The sign-in form accepts the Bearer token without placing it in the URL. The dashboard keeps it only in volatile memory for the current tab; it is cleared on logout, after 15 minutes without activity, or after a `401`, and a page reload requires signing in again. API requests are same-origin, send the token in the `Authorization` header, and use `cache: "no-store"`. The UI does not persist the token in browser storage, cookies, or a service worker.

Private `/v1/*` responses, including errors, use `Cache-Control: no-store`; dashboard HTML is also non-cacheable. The Worker applies a same-origin Content Security Policy (`default-src`, scripts, styles, and connections restricted to `'self'`; objects and framing disallowed; base URI restricted to `'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. Keep the local server local; do not enable a tunnel or remote bindings for this workflow.

## Dashboard backups and local restore

Before starting a dashboard export, review its warning: the export lock pauses scheduler work and blocks source changes while the snapshot is downloaded. The page shows the snapshot ID, record counts, page/record progress, and expiry. It attempts to release the lock after both a successful and a failed download; if cleanup cannot be confirmed, the UI reports that the lock may remain until the displayed expiry. On reload, an active snapshot can be recovered, but download starts again at page one so a partial remainder is never presented as a complete backup.

When supported, the browser writes the NDJSON incrementally to the selected file. Otherwise, the Blob fallback holds the complete backup in browser memory until download, which can use substantial memory for large snapshots. The dashboard does not provide remote restore, archival retention, or a whole-backup checksum. Restore remains a local CLI operation against a new, empty local D1 database:

```bash
D1_LOCAL_PERSIST=/tmp/media-aggregator-restore npm run restore:export -- "$BACKUP"
```

Choose a fresh disposable directory for `D1_LOCAL_PERSIST`; the command applies migrations with `--local`, disables remote bindings, and refuses a populated target. Keep the NDJSON file private. The existing restore command checks manifest counts and verifies retained article content hashes.

## Migrations and local checks

Wrangler local D1 uses a separate local database, not the production database. Apply migrations locally and run the checks before considering any production change:

```bash
npx wrangler d1 migrations list media-aggregator --local
npx wrangler d1 migrations apply media-aggregator --local
npm test
npm run test:dashboard
npm run lint
npm run typecheck
npm run typecheck:dashboard
npm run build:dashboard
npm run build
```

`npm run build:dashboard` writes assets only to `dashboard/dist/`. `npm run build` includes that dashboard build and runs Wrangler with `--dry-run`; it does not publish the Worker and does not use the repository root `dist/` as the dashboard asset source. For the normal local database use `--local`; for an isolated local database, pass the same fresh `--persist-to` directory to Wrangler D1 and `wrangler dev` commands. For a later, deliberate production migration, review the active Wrangler environment and database binding first, then use `npx wrangler d1 migrations apply media-aggregator --remote` only with the appropriate account authorization and change approval. Wrangler stores versioned SQL migration files under `migrations/`; see Cloudflare's [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [local development](https://developers.cloudflare.com/d1/best-practices/local-development/) guides.

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

Example machine export (requires `curl` and `jq`; keep `API_TOKEN` in the environment without printing it):

```bash
set -euo pipefail
umask 077
BASE_URL="https://api.example.com"
HEADERS=(-H "Authorization: Bearer $API_TOKEN")
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

For a disposable local database separate from the default Wrangler state, set `D1_LOCAL_PERSIST` to a new, empty local directory, for example: `D1_LOCAL_PERSIST=/tmp/media-aggregator-restore npm run restore:export -- "$BACKUP"`.

## Resource caps and operational behavior

The export contract is **10 lines and 3 MiB per page**, with the manifest counting as one line. The export lock lasts 30 minutes. Only one active session is allowed; completed and stale session rows are removed on end/restart/expiry, and a new session must pass the shared D1 storage gate. Full article text is capped by the schema at 512,000 UTF-8 bytes per article; page size is checked after encoding and serialization, so page lengths vary with metadata and text. For `content_too_large`, the stored/exported full text is empty while `content_hash` remains the SHA-256 of the fetched oversized body; restore preserves that hash and validates the status/empty-body exception, since the discarded body cannot be rehashed from the backup.

This project starts blocking storage-growing writes at 280 MiB and defines a 300 MiB hard cap (`src/ingest/storage-guard.ts`), below Cloudflare D1's 500 MB per-database Free limit. Cloudflare currently documents a 5 GB Free account storage cap, 50 D1 queries per Worker invocation on Free, 2,000,000 bytes maximum for a row, and 50 MB maximum for a query result. Starting September 1, 2026, Free-plan D1 also enforces daily row-read/write quotas and resets exceeded limits at midnight UTC; see the [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [daily quota enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

Workers Free currently allows 100,000 requests per day, 10 ms CPU per HTTP/Cron invocation, and 50 subrequests per invocation. The local throughput fixture measures elapsed time for parsing a 100-item feed and persisting it through ten 10-row D1 batches under the Workers test runtime; local elapsed time includes D1 overhead and is not the same as billed CPU time. Production CPU behavior against the 10 ms budget remains unverified because no deployment is part of this work. Keep exports paginated, limit concurrent exports to the single existing lock, and avoid doing large export/restore work inside an ingestion or request path. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before increasing caps or moving to a different plan.

No Cloudflare account resource was created and nothing was deployed for this task.
