// Property test — Upload_Status_Bar done-count derivation (Task 1.4).
//
// Property 4 (design.md "Correctness Properties"):
//   For any current batch of Upload_Items, the first text row's done-count
//   equals the number of items whose status is `success`, the total equals the
//   number of items in the batch, the done-count never exceeds the total, and
//   the rendered string is exactly `"{done} de {total}"`.
//
//   Validates: Requirements 3.2
//
// This is a UNIT-level property against the REAL `doneCount` exported by
// app/components/upload-status.ts. The function is pure (array of statuses in,
// number out), so fast-check exercises it directly over arbitrary batches of
// UploadStatus values. The `"{done} de {total}"` format is the exact string the
// UI renders (total = items.length), asserted here as a pure derivation.

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { doneCount } from "@/app/components/upload-status";
import type { UploadStatus } from "@/app/src/stores/upload.store";

// --- fast-check generators ----------------------------------------------------

// The full UploadStatus union — the generator spans the entire input space so
// the property holds regardless of how many items are success/failed/etc.
const uploadStatusArb: fc.Arbitrary<UploadStatus> = fc.constantFrom(
  "queued",
  "processing",
  "uploading",
  "success",
  "failed",
  "exhausted",
  "canceled",
);

// A batch is an array of items each carrying an arbitrary status. Empty batches
// are included (minLength 0) so the [] boundary is exercised too.
const batchArb = fc.array(
  fc.record({ status: uploadStatusArb }),
  { minLength: 0, maxLength: 50 },
);

const NUM_RUNS = 200;

describe("Feature: upload-status-bar, Property 4: Done-count text reflects success count out of batch total", () => {
  it("doneCount equals the success count, never exceeds total, and formats as \"{done} de {total}\"", () => {
    fc.assert(
      fc.property(batchArb, (items) => {
        const done = doneCount(items);
        const total = items.length;

        // Reference success count computed independently of the SUT.
        const expectedSuccess = items.filter(
          (item) => item.status === "success",
        ).length;

        // THE PROPERTY:
        // 1. done-count equals the number of `success` items.
        expect(done).toBe(expectedSuccess);

        // 2. done-count never exceeds the batch total.
        expect(done).toBeLessThanOrEqual(total);
        expect(done).toBeGreaterThanOrEqual(0);

        // 3. the rendered first-row string is exactly `"{done} de {total}"`.
        const rendered = `${done} de ${total}`;
        expect(rendered).toBe(`${expectedSuccess} de ${items.length}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
