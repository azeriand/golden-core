// Property test — Upload_Status_Bar ring geometry — Task 1.3.
//
// Property 3 (design.md "Correctness Properties"):
//   For any Aggregate_Progress percentage in 0-100 and any positive ring
//   circumference, the ring stroke-dash offset lies within 0 to the
//   circumference inclusive, decreases monotonically as the percentage
//   increases, equals the full circumference at 0% (empty ring), and equals 0
//   at 100% (full ring) — so the visible fill is exactly proportional to the
//   percentage.
//
//   Validates: Requirements 2.3
//
// This is a UNIT-level property against the REAL `ringDashOffset` exported by
// app/components/upload-status.ts, implemented as
//   circumference * (1 - clamp(percent, 0, 100) / 100).
// The function is pure (percent + circumference in, offset out), so fast-check
// exercises it directly over arbitrary valid percentages and positive
// circumferences.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ringDashOffset } from "@/app/components/upload-status";

const NUM_RUNS = 300;

// Percentages within the valid 0-100 range (fractional allowed: the ring is a
// pure function of a real-valued percent).
const percentArb = fc.double({ min: 0, max: 100, noNaN: true });

// A strictly positive, finite circumference (a ring always has positive length).
const circumferenceArb = fc.double({
  min: Number.MIN_VALUE,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

describe("Feature: upload-status-bar, Property 3: Ring fill is proportional and monotonic", () => {
  it("offset lies within [0, circumference] for any valid percent", () => {
    fc.assert(
      fc.property(percentArb, circumferenceArb, (percent, circumference) => {
        const offset = ringDashOffset(percent, circumference);
        expect(offset).toBeGreaterThanOrEqual(0);
        // Tiny epsilon tolerance for floating-point rounding at the upper bound.
        expect(offset).toBeLessThanOrEqual(circumference + 1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("decreases monotonically (non-increasing) as percent increases", () => {
    fc.assert(
      fc.property(
        percentArb,
        percentArb,
        circumferenceArb,
        (a, b, circumference) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const offsetLo = ringDashOffset(lo, circumference);
          const offsetHi = ringDashOffset(hi, circumference);
          // Higher percent => smaller-or-equal offset (more fill).
          expect(offsetHi).toBeLessThanOrEqual(offsetLo + 1e-9);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("is strictly decreasing when the two percents meaningfully differ", () => {
    // Property 3 requires the offset to DECREASE monotonically as percent grows
    // (verified above as non-increasing). Strict decrease holds for any real
    // gap, but at IEEE-754 extremes (e.g. a subnormal circumference of 5e-324
    // with a subnormal percent gap) the two products underflow to the SAME
    // float, so "strictly less" is unrepresentable. Those degenerate inputs are
    // a floating-point artifact, not a behavior the spec cares about, so we
    // constrain to a meaningful percent gap and a non-degenerate circumference.
    const meaningfulCircumferenceArb = fc.double({
      min: 1e-3,
      max: 1e6,
      noNaN: true,
      noDefaultInfinity: true,
    });
    fc.assert(
      fc.property(
        percentArb,
        percentArb,
        meaningfulCircumferenceArb,
        (a, b, circumference) => {
          // Only compare when the percents differ by a representable amount.
          fc.pre(Math.abs(a - b) >= 1e-6);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const offsetLo = ringDashOffset(lo, circumference);
          const offsetHi = ringDashOffset(hi, circumference);
          // The higher percent yields a strictly smaller offset (more fill).
          expect(offsetHi).toBeLessThan(offsetLo);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("equals the full circumference at 0% (empty ring)", () => {
    fc.assert(
      fc.property(circumferenceArb, (circumference) => {
        expect(ringDashOffset(0, circumference)).toBe(circumference);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("equals 0 at 100% (full ring)", () => {
    fc.assert(
      fc.property(circumferenceArb, (circumference) => {
        expect(ringDashOffset(100, circumference)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is exactly proportional: offset = circumference * (1 - percent/100)", () => {
    fc.assert(
      fc.property(percentArb, circumferenceArb, (percent, circumference) => {
        const expected = circumference * (1 - percent / 100);
        expect(ringDashOffset(percent, circumference)).toBeCloseTo(expected, 9);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
