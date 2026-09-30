// Property test — Upload_Status_Bar phase/visibility state machine — Task 3.2.
//
// Property 1 (design.md "Correctness Properties"):
//   For any sequence of Upload_Store snapshots (each a list of Upload_Items
//   with arbitrary statuses) applied in order, the bar's phase satisfies:
//   whenever the number of Active_Uploads (items with status `queued`,
//   `processing`, or `uploading`) is greater than zero, the phase is `active`
//   (and the bar is visible); when it drops to zero after having been `active`,
//   the phase becomes `completion` (visible) regardless of how many items ended
//   `failed`, `exhausted`, `canceled`, or `success`; a new Active_Upload
//   appearing during `completion` returns the phase to `active` and cancels any
//   pending auto-hide; and the bar is hidden only when no Active_Upload exists
//   and no `completion` display is in effect.
//
//   Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.4, 4.6
//
// This is a UNIT-level property against the REAL pure transition exported by
// app/components/upload-status-bar.tsx:
//   nextPhase(state, activeCount) -> { state, startHideTimer, clearHideTimer }
// plus INITIAL_PHASE_STATE. The active count each step is derived from an
// arbitrary batch of UploadStatus values via the REAL `activeUploadCount` from
// app/components/upload-status.ts, so the Active_Upload definition (queued |
// processing | uploading) is exercised as the component uses it.
//
// The React auto-hide timer is modeled as a pure contract: `startHideTimer`
// arms a pending hide and `clearHideTimer` cancels it. A separate "timer fires"
// event (only possible while a hide is pending and no active upload) drives the
// phase to `hidden` and resets the run latch — mirroring the component's
// setTimeout callback `setState({ phase: "hidden", hasBeenActive: false })`.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.4, 4.6**

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  nextPhase,
  INITIAL_PHASE_STATE,
  type PhaseState,
} from "@/app/components/upload-status-bar";
import { activeUploadCount } from "@/app/components/upload-status";
import type { UploadStatus } from "@/app/src/stores/upload.store";

// --- fast-check generators ----------------------------------------------------

// The full UploadStatus union so generated snapshots span the entire input
// space (active + all terminal outcomes: failed/exhausted/canceled/success).
const uploadStatusArb: fc.Arbitrary<UploadStatus> = fc.constantFrom(
  "queued",
  "processing",
  "uploading",
  "success",
  "failed",
  "exhausted",
  "canceled",
);

// A snapshot is a batch of items each carrying an arbitrary status. Empty
// batches (minLength 0) are included so the "no items" boundary is exercised.
const snapshotArb = fc.array(fc.record({ status: uploadStatusArb }), {
  minLength: 0,
  maxLength: 12,
});

// A step is EITHER a new store snapshot (which yields an activeCount) OR a
// "timer fires" event. Timer firing is only meaningful while a hide is pending;
// the reducer below ignores it otherwise (the component never fires a cleared
// timer).
type Step =
  | { kind: "snapshot"; items: { status: UploadStatus }[] }
  | { kind: "timerFire" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: snapshotArb.map((items) => ({ kind: "snapshot" as const, items })) },
  { weight: 1, arbitrary: fc.constant({ kind: "timerFire" as const }) },
);

const sequenceArb = fc.array(stepArb, { minLength: 1, maxLength: 40 });

const NUM_RUNS = 300;

// --- a faithful driver of the component's effect + timer wiring ---------------
//
// Mirrors UploadStatusBar's effect: on each activeCount change it applies
// nextPhase, clearing/arming the pending-hide timer per the returned flags. The
// "timerFire" event models the setTimeout callback firing.

interface Machine {
  state: PhaseState;
  hidePending: boolean; // a setTimeout is armed and not yet fired/cleared
}

function applySnapshot(m: Machine, activeCount: number): Machine {
  const { state, startHideTimer, clearHideTimer } = nextPhase(m.state, activeCount);
  let hidePending = m.hidePending;
  if (clearHideTimer) hidePending = false;
  if (startHideTimer) hidePending = true;
  return { state, hidePending };
}

function applyTimerFire(m: Machine): Machine {
  // The component's timer callback only exists while a hide is pending; firing
  // hides the bar and resets the run latch. If no hide is pending, nothing
  // happens (a cleared timer can never fire).
  if (!m.hidePending) return m;
  return { state: { phase: "hidden", hasBeenActive: false }, hidePending: false };
}

const VISIBLE_PHASES = new Set<PhaseState["phase"]>(["active", "completion"]);

describe("Feature: upload-status-bar, Property 1: Phase/visibility state machine", () => {
  it("Feature: upload-status-bar, Property 1: Phase/visibility state machine", () => {
    fc.assert(
      fc.property(sequenceArb, (steps) => {
        let m: Machine = { state: INITIAL_PHASE_STATE, hidePending: false };

        for (const step of steps) {
          const before = m;

          if (step.kind === "timerFire") {
            m = applyTimerFire(m);
            if (before.hidePending) {
              // A pending auto-hide firing hides the bar (Req 4.5) and clears
              // the pending flag.
              expect(m.state.phase).toBe("hidden");
              expect(m.hidePending).toBe(false);
            } else {
              // No hide was pending: a cleared/absent timer can never fire, so
              // the machine is unchanged.
              expect(m).toBe(before);
            }
            continue;
          }

          const active = activeUploadCount(step.items);
          m = applySnapshot(m, active);

          if (active > 0) {
            // Req 1.1 / 1.3 / 4.6: any active upload => phase active & visible,
            // and any pending auto-hide is cancelled.
            expect(m.state.phase).toBe("active");
            expect(VISIBLE_PHASES.has(m.state.phase)).toBe(true);
            expect(m.hidePending).toBe(false);
            expect(m.state.hasBeenActive).toBe(true);
          } else {
            // active === 0.
            if (before.state.phase === "active" && before.state.hasBeenActive) {
              // Req 4.1 / 4.4: draining to zero after being active latches
              // completion regardless of failed/exhausted/canceled/success, and
              // arms the auto-hide.
              expect(m.state.phase).toBe("completion");
              expect(m.hidePending).toBe(true);
            } else {
              // Already hidden or already completion: phase unchanged.
              expect(m.state.phase).toBe(before.state.phase);
            }
          }
        }

        // GLOBAL INVARIANTS after the whole sequence:
        // Hidden implies no pending completion hide is outstanding.
        if (m.state.phase === "hidden") {
          expect(m.hidePending).toBe(false);
        }
        // A pending auto-hide only ever coexists with the completion display.
        if (m.hidePending) {
          expect(m.state.phase).toBe("completion");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("re-entry: a new active upload during completion returns to active and cancels the pending hide", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // active count for the first batch
        fc.integer({ min: 1, max: 20 }), // active count for the re-entry batch
        (firstActive, reentryActive) => {
          // 1. Start a batch (become active).
          let m: Machine = { state: INITIAL_PHASE_STATE, hidePending: false };
          m = applySnapshot(m, firstActive);
          expect(m.state.phase).toBe("active");

          // 2. Drain to zero -> completion with a pending auto-hide.
          m = applySnapshot(m, 0);
          expect(m.state.phase).toBe("completion");
          expect(m.hidePending).toBe(true);

          // 3. A new active upload arrives during completion (Req 4.6).
          m = applySnapshot(m, reentryActive);
          expect(m.state.phase).toBe("active");
          expect(m.hidePending).toBe(false); // pending hide cancelled
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("never shows completion on first mount over an empty/idle store", () => {
    // hasBeenActive gates completion (Req 4.1): a store that has never had an
    // active upload stays hidden even as it drains through zero repeatedly.
    fc.assert(
      fc.property(fc.array(fc.constant(0), { minLength: 1, maxLength: 20 }), (zeros) => {
        let m: Machine = { state: INITIAL_PHASE_STATE, hidePending: false };
        for (const z of zeros) {
          m = applySnapshot(m, z);
          expect(m.state.phase).toBe("hidden");
          expect(m.hidePending).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
