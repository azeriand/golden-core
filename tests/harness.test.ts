// Harness sanity check ONLY — Task 13.1 (test infrastructure setup).
// This file exists solely to prove the Vitest runner and fast-check are wired
// up. It tests NO application code. Real unit/property tests (P1-P7) are added
// in tasks 13.2-13.7 alongside the modules they cover.
import { describe, it, expect } from "vitest";
import fc from "fast-check";

describe("test harness sanity", () => {
  it("runs vitest assertions", () => {
    expect(true).toBe(true);
  });

  it("runs a trivial fast-check property", () => {
    fc.assert(fc.property(fc.integer(), (n) => n === n));
  });
});
