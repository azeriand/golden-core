// Property test — Task 1.2 — Upload_Status_Bar aggregate progress.
//
// Property 2 (design.md "Correctness Properties"):
//   For any list of Upload_Item `progress` values in the range 0-100, the
//   computed Aggregate_Progress equals the arithmetic mean of those values
//   rounded to a whole number, always lies within 0-100 inclusive, equals that
//   common value when all inputs are equal, and equals 0 for an empty batch.
//   Validates: Requirements 2.2, 2.4
//
// This is a UNIT-level property against the REAL `aggregateProgress` exported
// by app/components/upload-status.ts. The function is pure (number[] in, number
// out) so fast-check exercises it directly over arbitrary progress lists. No
// boundaries are mocked.
//
// **Validates: Requirements 2.2, 2.4**

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { aggregateProgress } from "@/app/components/upload-status";

// --- fast-check generators ----------------------------------------------------

// Upload_Item progress values live in the range 0-100 (the glossary defines
// `progress` as 0-100). Use whole and fractional values to widen the input
// space while staying inside the valid domain the store produces.
const progressArb = fc.double({
  min: 0,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
});

// A batch of progress values (non-empty here; the empty case is asserted
// separately as an example so it is always exercised).
const progressListArb = fc.array(progressArb, { minLength: 1, maxLength: 50 });

const NUM_RUNS = 200;

// Reference arithmetic mean (kept independent of the implementation).
function meanOf(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe("Feature: upload-status-bar, Property 2: Aggregate progress is the whole-number mean, bounded", () => {
  it("Feature: upload-status-bar, Property 2: Aggregate progress is the whole-number mean, bounded", () => {
    fc.assert(
      fc.property(progressListArb, (progresses) => {
        const result = aggregateProgress(progresses);

        // Equals the arithmetic mean rounded to a whole number (Req 2.2 / 2.4).
        expect(result).toBe(Math.round(meanOf(progresses)));

        // Result is a whole number.
        expect(Number.isInteger(result)).toBe(true);

        // Bounded within [0, 100] inclusive (Req 2.4).
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(100);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("equals the common value when all inputs are equal", () => {
    fc.assert(
      fc.property(
        // A single common value (whole number so the mean is exact and the
        // rounded result equals it precisely).
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 50 }),
        (common, count) => {
          const progresses = Array.from({ length: count }, () => common);

          // The mean of N copies of `common` is `common`, and rounding an
          // integer is a no-op, so the result equals the common value.
          expect(aggregateProgress(progresses)).toBe(common);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("equals 0 for an empty batch", () => {
    // No division by zero: the empty batch yields 0 (Req 2.4).
    expect(aggregateProgress([])).toBe(0);
  });
});
