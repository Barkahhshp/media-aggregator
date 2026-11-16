export interface Env {
  DB: D1Database;
  APP_ENV: "test" | "local" | "production";
  API_TOKEN?: string;
}
