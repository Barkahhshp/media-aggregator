import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const outputDirectory = resolve(process.cwd(), "dashboard/dist");

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

describe("dashboard build artifacts", () => {
  it("builds only into dashboard/dist without source maps or embedded test credentials", () => {
    const files = listFiles(outputDirectory);
    const contents = files.map((file) => readFileSync(file, "utf8")).join("\n");

    expect(files.some((file) => file.endsWith("/index.html"))).toBe(true);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    expect(contents).not.toContain("task-9-test-token");
  });
});
