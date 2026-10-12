import { describe, expect, it } from "vitest";
import fc from "fast-check";

/**
 * Harness smoke test: proves Vitest runs, `fast-check` is wired in, and the
 * project-wide 100-iteration floor from `test/setup.ts` is actually applied.
 * The real correctness properties live beside their services in later tasks.
 */
describe("test harness", () => {
  it("runs Vitest assertions", () => {
    expect(1 + 1).toBe(2);
  });

  it("applies the global fast-check floor of 100 runs", () => {
    expect(fc.readConfigureGlobal().numRuns).toBe(100);
  });

  it("executes a fast-check property", () => {
    let runs = 0;
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        runs += 1;
        return a + b === b + a;
      })
    );
    expect(runs).toBeGreaterThanOrEqual(100);
  });
});
