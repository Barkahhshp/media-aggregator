import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("restore CLI resolves its TypeScript imports under Node type stripping", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/restore-export.ts"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run restore:export -- <export\.ndjson>/u);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
});
