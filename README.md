# media-aggregator

A Cloudflare Workers RSS/news aggregator. The service is intended for internal use and keeps production deployment disabled until a protected custom hostname is configured.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Apply the D1 schema to a local database with:

```sh
npx wrangler d1 migrations apply media-aggregator --local
```

The local Worker uses `APP_ENV=local`. Set any local-only API token in `.dev.vars`; never commit that file. Production uses `APP_ENV=production` and must be protected by Cloudflare Access on a custom hostname. Do not enable `workers.dev` for production.
