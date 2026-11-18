export interface Env {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN?: string;
  ASSETS?: Fetcher;
}
