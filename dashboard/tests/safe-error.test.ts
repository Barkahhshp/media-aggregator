import { describe, expect, it } from "vitest";
import { safeApiErrorMessage } from "../src/api/safe-error";

describe("safe API error messages", () => {
  it("normalizes controls and caps the displayed message length", () => {
    const message = `Request failed\n\u0001${"x".repeat(400)}`;
    const result = safeApiErrorMessage({ error: { code: "internal_error", message } }, 500, "Run");

    expect(result.length).toBeLessThanOrEqual(240);
    expect(result.includes("\n")).toBe(false);
    expect(result.includes("\u0001")).toBe(false);
    expect(result.endsWith("…")).toBe(true);
  });

  it("uses a generic fallback for malformed or blank error envelopes", () => {
    expect(safeApiErrorMessage({ error: { message: "internal details" } }, 500, "Run"))
      .toBe("Run request failed (HTTP 500)");
    expect(safeApiErrorMessage({ error: { code: "internal_error", message: " \n\t " } }, 503, "Error"))
      .toBe("Error request failed (HTTP 503)");
  });

  it("preserves a short, well-formed API message", () => {
    expect(safeApiErrorMessage({ error: { code: "invalid_request", message: "Filter is not supported" } }, 400, "Run"))
      .toBe("Filter is not supported");
  });
});
