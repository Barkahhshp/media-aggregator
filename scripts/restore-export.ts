import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { Env } from "../src/env.ts";
import { parseExportNdjson, restoreParsedExport } from "../src/exports/restore.ts";

const DATABASE_NAME = "media-aggregator";
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_PERSIST_PATH = process.env.D1_LOCAL_PERSIST ? resolve(process.env.D1_LOCAL_PERSIST) : null;
const PLATFORM_PERSIST_PATH = LOCAL_PERSIST_PATH === null ? null : resolve(LOCAL_PERSIST_PATH, "v3");

function applyLocalMigrations(): void {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(executable, [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    DATABASE_NAME,
    "--local",
    ...(LOCAL_PERSIST_PATH === null ? [] : ["--persist-to", LOCAL_PERSIST_PATH]),
  ], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Local D1 migrations failed${result.error ? `: ${result.error.message}` : ""}`);
  }
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length > 3) {
    throw new Error("Usage: npm run restore:export -- <export.ndjson>");
  }
  const ndjson = await readFile(resolve(inputPath), "utf8");
  const parsed = await parseExportNdjson(ndjson);
  applyLocalMigrations();

  const platform = await getPlatformProxy<Env>({
    configPath: resolve(PROJECT_ROOT, "wrangler.jsonc"),
    persist: PLATFORM_PERSIST_PATH === null ? true : { path: PLATFORM_PERSIST_PATH },
    remoteBindings: false,
  });
  try {
    const result = await restoreParsedExport(platform.env.DB, parsed);
    process.stdout.write(`${JSON.stringify({ status: "restored", ...result })}\n`);
  } finally {
    await platform.dispose();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Restore failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
