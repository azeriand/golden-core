// Property 13: One failing job does not block others (Task 10.3).
//
// For a claimed batch in which an ARBITRARY SUBSET of jobs "fails", every
// non-failing job is still processed to completion in the same run, and the
// failing jobs do not prevent the others from being dispatched/processed
// (Requirement 17.4).
//
// How this exercises the REAL runtime:
//   - It imports the REAL `tick` + `createWorkerState` from ../src/index.js
//     (no re-implementation of the loop body).
//   - It injects a mocked `claimJobs` that returns a fast-check-generated batch
//     on the first tick and an empty batch thereafter.
//   - It injects a mocked `processJob` that mirrors process-job.ts's real
//     contract: a normal processing failure NEVER throws (the real pipeline
//     converts a failure into a failJob transition and a log line, Req 17.4).
//     The mock therefore RESOLVES for both "succeeding" and "failing" jobs, but
//     records the outcome so the test can assert isolation. Every job the mock
//     is asked to process is recorded as "processed to completion in this run".
//   - reclaimStaleProcessing is a no-op (returns 0) so the tick's only work is
//     the claimed batch.
//
// The batch is sized within one tick's free capacity (N) so the whole generated
// set is claimed and dispatched in a single run, matching "in the same run".
//
// **Validates: Requirements 17.4**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createWorkerState,
  tick,
  type TickDeps,
} from '../src/index.js';
import type { PosterJob } from '../src/queue.js';

/**
 * Build a claimed PosterJob for a given id. The failing subset is decided by the
 * generated `failingIds` set in the test, not by the job shape, so every claimed
 * job looks identical to the worker (the worker does not know in advance which
 * will fail).
 */
function makeJob(id: number): PosterJob {
  return {
    id,
    media_id: 1000 + id,
    status: 'processing', // claimJobs already flipped it to 'processing'
    attempts: 0,
    run_after: new Date().toISOString(),
  };
}

describe('Property 13: one failing job does not block others', () => {
  it('processes every non-failing job to completion even when an arbitrary subset fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A non-empty set of unique job ids to claim in one batch.
        fc
          .uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
            minLength: 1,
            maxLength: 12,
          })
          // For each id, a boolean deciding whether that job "fails".
          .chain((ids) =>
            fc.record({
              ids: fc.constant(ids),
              failing: fc.array(fc.boolean(), {
                minLength: ids.length,
                maxLength: ids.length,
              }),
            }),
          ),
        async ({ ids, failing }) => {
          // The concurrency ceiling N is at least the batch size so the entire
          // generated batch is claimable in a single tick ("same run").
          const concurrency = ids.length;

          // Set of ids designated to fail this run.
          const failingIds = new Set<number>(
            ids.filter((_, i) => failing[i]),
          );

          const batch = ids.map(makeJob);

          // Record which jobs were actually processed to completion (i.e. the
          // worker dispatched them and their processing settled), and the
          // outcome we simulated for each.
          const processed: number[] = [];
          const succeeded = new Set<number>();
          const failed = new Set<number>();

          // First tick returns the whole generated batch; later ticks (if any)
          // return nothing. This isolates the assertion to a single run.
          let claimCalls = 0;

          const deps: TickDeps = {
            concurrency,
            staleProcessingSeconds: 60,
            reclaimStaleProcessing: async () => 0,
            claimJobs: async (limit) => {
              claimCalls += 1;
              if (claimCalls === 1) {
                // Never hand back more than the worker's free capacity asked for.
                return batch.slice(0, limit);
              }
              return [];
            },
            // Mirror process-job.ts's real contract: a normal failure RESOLVES
            // (never throws). We record completion for EVERY job, and separately
            // track whether we simulated a failure for it.
            processJob: async (job: PosterJob) => {
              processed.push(job.id);
              if (failingIds.has(job.id)) {
                failed.add(job.id);
                // Resolve without throwing, exactly like processJob routing to
                // failJob internally (Req 17.4).
                return;
              }
              succeeded.add(job.id);
              return;
            },
          };

          const state = createWorkerState();

          // Drive a single tick and await every dispatched job so the run's
          // processing has fully settled before we assert.
          const dispatched = await tick(state, deps);
          await Promise.all(dispatched);

          // The whole batch was dispatched in this one run.
          expect(dispatched.length).toBe(batch.length);

          // Every job in the batch was processed to completion in the same run,
          // regardless of the failing subset (the core isolation guarantee).
          expect(processed.slice().sort((a, b) => a - b)).toEqual(
            ids.slice().sort((a, b) => a - b),
          );

          // Every NON-failing job succeeded to completion — a failing job did
          // not prevent processing of the others (Req 17.4).
          for (const id of ids) {
            if (failingIds.has(id)) {
              expect(failed.has(id)).toBe(true);
            } else {
              expect(succeeded.has(id)).toBe(true);
            }
          }

          // Non-failing set is exactly the complement of the failing set, and
          // together they cover the whole batch — nothing was skipped.
          expect(succeeded.size + failed.size).toBe(ids.length);

          // In-flight count returns to zero after the run drains: a failing job
          // does not leak capacity that would block subsequent work (Req 17.4).
          expect(state.inFlight).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
