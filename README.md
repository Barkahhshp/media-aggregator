# media-aggregator

An internal-use RSS/news aggregator on Cloudflare Workers and D1. Production remains disabled until a protected custom hostname is deliberately configured. The approved authentication design uses one owner Bearer token (`API_TOKEN`); Cloudflare Access/Zero Trust is not required. Keep `workers.dev` disabled for production.

## Development

```sh
npm ci
npm test
npm run test:dashboard
npm run lint
npm run typecheck
npm run typecheck:dashboard
npm run build
```

`npm run build` builds the dashboard into `dashboard/dist/` and then runs a Wrangler dry-run build; it does not publish the Worker. Never put credentials or `.dev.vars` contents in this repository or in documentation.

## Run the dashboard locally

Create a local-only `API_TOKEN` in the ignored `.dev.vars` file, then run these commands from the repository root. A fresh persistence directory keeps this session's D1 separate from your normal Wrangler local database:

```sh
LOCAL_STATE="$(mktemp -d)"
npx wrangler d1 migrations apply media-aggregator --local --persist-to "$LOCAL_STATE"
npx wrangler d1 migrations list media-aggregator --local --persist-to "$LOCAL_STATE"
npm run build:dashboard
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to "$LOCAL_STATE"
```

Open <http://127.0.0.1:8787> and sign in with that local token. The dashboard and `/v1/*` API share the Worker origin. The token stays in tab memory only, is cleared after 15 minutes without activity or on logout/401, and must be entered again after a reload. See [the operations guide](docs/operations.md) for security headers, export behavior, and local restore instructions.
