// Property test P18 — "Bounded concurrency is respected" — Task 10.2.
//
// Property 6 (design.md "Correctness Properties"):
//   For any configured concurrency `N >= 1` and any arrival pattern of due jobs,
//   the number of jobs simultaneously in `processing` by a single worker never
//   exceeds `N`.
//   Validates: Requirements 7.3, 7.4, 7.6
//
// Why this property holds in index.ts:
//   The poll loop's `tick` (worker/src/index.ts) enforces bounded concurrency in
//   two places against the shared, mutable WorkerState.inFlight:
//     - It computes `freeCapacity = concurrency - inFlight` and claims AT MOST
//       that many jobs; when `freeCapacity <= 0` it claims nothing (Req 7.4).
//     - For each dispatched job it increments `inFlight` BEFORE awaiting
//       processJob and decrements it in a `finally` when processing settles, so
//       inFlight is an accurate live count and a job that stays "in flight"
//       (its processJob promise unresolved) keeps holding capacity (Req 7.3).
//   Because a tick never claims beyond the free capacity, and dispatched jobs
//   hold their slot until they settle, the number of jobs simultaneously being
//   processed by one worker can never exceed N.
//
// Modeling approach (mirrors the dependency-injected style of P10/P14):
//   We drive the REAL `tick` + `createWorkerState` from worker/src/index over
//   MANY cycles with fully mocked TickDeps:
//     - reclaimStaleProcessing: returns 0 (no reclaim churn; isolates the
//       claim/dispatch concurrency invariant).
//     - claimJobs(limit): hands out up to `limit` jobs drawn from a generated
//       arrival pattern (a queue of pending jobs). Because `tick` only ever
//       calls this with `freeCapacity = N - inFlight`, the arrival pattern
//       supplies WORK, but the loop decides how much to take.
//     - processJob(job): returns a CONTROLLABLE pending promise so dispatched
//       jobs stay in-flight until the test explicitly resolves them. A shared
//       counter is incremented on entry and decremented on resolve; the observed
//       maximum of that counter is the true simultaneous-processing peak.
//   Interleaving is exercised by resolving only a random subset of in-flight
//   jobs between ticks, so at any moment a mix of held and freed slots exists.
//
// TYPING NOTE: TickDeps and WorkerState are imported directly from
//   worker/src/index; the mocked deps satisfy the exact interface so this file
//   introduces NO new tsc errors.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
    tick,
    createWorkerState,
    type TickDeps,
    type WorkerState,
} from '../worker/src/index';
import type { PosterJob } from '../worker/src/queue';

// --- Controllable in-flight processJob harness -------------------------------

// One dispatched job's controllable promise: `resolve()` settles it, freeing the
// worker's slot (the `finally` in tick decrements inFlight).
interface Pending {
    jobId: number;
    resolve: () => void;
    promise: Promise<void>;
}

// Tracks the live count of processJob executions that have STARTED but not yet
// settled, plus the running maximum ever observed. This is the ground-truth
// "simultaneously in processing" measurement the property asserts on.
class ConcurrencyTracker {
    live = 0;
    max = 0;
    private pendings: Pending[] = [];

    // The mocked processJob: increment on entry, hand back a promise that only
    // settles when the test resolves it, decrement on settle.
    makeProcessJob(): (job: PosterJob) => Promise<void> {
        return (job: PosterJob) => {
            this.live += 1;
            if (this.live > this.max) this.max = this.live;

            let resolveFn!: () => void;
            const promise = new Promise<void>((res) => {
                resolveFn = res;
            }).then(() => {
                this.live -= 1;
            });

            this.pendings.push({ jobId: job.id, resolve: resolveFn, promise });
            return promise;
        };
    }

    // Resolve up to `count` of the currently-held jobs (frees their slots).
    async resolveSome(count: number): Promise<void> {
        const toResolve = this.pendings.splice(0, Math.max(0, count));
        for (const p of toResolve) p.resolve();
        // Await the decrement side-effects so `live` reflects the resolutions
        // before the next tick reads inFlight.
        await Promise.all(toResolve.map((p) => p.promise));
    }

    // Resolve everything still in flight (used to drain at the end).
    async resolveAll(): Promise<void> {
        await this.resolveSome(this.pendings.length);
    }

    outstanding(): number {
        return this.pendings.length;
    }
}

// --- Arrival-pattern-backed claimJobs ----------------------------------------

// A generated arrival pattern is a queue of pending jobs. claimJobs(limit) hands
// out up to `limit` of them (FIFO), so the worker — not the pattern — decides
// how many enter processing each cycle. Extra "arrivals" per cycle are modeled
// by enqueuing more jobs between ticks.
function makeClaimJobs(queue: PosterJob[]): (limit: number) => Promise<PosterJob[]> {
    return async (limit: number) => {
        if (limit <= 0) return [];
        return queue.splice(0, limit);
    };
}

function makeJob(id: number): PosterJob {
    return {
        id,
        media_id: id,
        status: 'pending',
        attempts: 0,
        run_after: new Date(0).toISOString(),
    };
}

// --- fast-check generators ----------------------------------------------------

// A single simulation step: how many NEW jobs "arrive" (become claimable) this
// cycle, and how many currently in-flight jobs we resolve AFTER the tick.
const stepArb = fc.record({
    arrivals: fc.integer({ min: 0, max: 10 }),
    resolveCount: fc.integer({ min: 0, max: 10 }),
});

const scenarioArb = fc.record({
    // Bounded concurrency N >= 1 (Req 7.3, 7.6).
    concurrency: fc.integer({ min: 1, max: 8 }),
    // Any arrival pattern: a sequence of cycles with arrivals + resolutions.
    steps: fc.array(stepArb, { minLength: 1, maxLength: 40 }),
});

const NUM_RUNS = 200;

describe('P18 — bounded concurrency is respected', () => {
    it('driving ticks never exceeds N simultaneous processJob executions or inFlight', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async ({ concurrency, steps }) => {
                const tracker = new ConcurrencyTracker();
                const queue: PosterJob[] = [];
                let nextId = 1;

                const state: WorkerState = createWorkerState();
                const deps: TickDeps = {
                    concurrency,
                    staleProcessingSeconds: 300,
                    reclaimStaleProcessing: async () => 0,
                    claimJobs: makeClaimJobs(queue),
                    processJob: tracker.makeProcessJob(),
                };

                // Track the worst inFlight ever observed just after each tick.
                let maxInFlight = 0;

                for (const step of steps) {
                    // New arrivals become claimable this cycle.
                    for (let i = 0; i < step.arrivals; i += 1) {
                        queue.push(makeJob(nextId++));
                    }

                    // Run exactly one Poll_Cycle body. tick dispatches at most
                    // `N - inFlight` jobs and increments inFlight before awaiting
                    // each dispatched (pending) processJob.
                    await tick(state, deps);

                    // INVARIANT (Req 7.3/7.4): after a tick, the live count of
                    // simultaneously-processing jobs and the worker's own
                    // inFlight counter must both be within N.
                    if (state.inFlight > maxInFlight) maxInFlight = state.inFlight;
                    expect(state.inFlight).toBeLessThanOrEqual(concurrency);
                    expect(tracker.live).toBeLessThanOrEqual(concurrency);
                    // The tracker's live count and the worker's inFlight agree:
                    // every dispatched job is still in flight until resolved.
                    expect(tracker.live).toBe(state.inFlight);

                    // Resolve a subset of in-flight jobs, freeing capacity for
                    // subsequent cycles (models jobs finishing at various times).
                    await tracker.resolveSome(step.resolveCount);
                }

                // Drain any remaining in-flight jobs.
                await tracker.resolveAll();

                // Final observed peak across the whole run must respect N.
                expect(tracker.max).toBeLessThanOrEqual(concurrency);
                expect(maxInFlight).toBeLessThanOrEqual(concurrency);
                // After draining everything, no job is left in flight.
                expect(state.inFlight).toBe(0);
                expect(tracker.live).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a saturated queue never pushes simultaneous processing above N', async () => {
        // Focused case: far more work than capacity, never resolving mid-run, so
        // the loop must stop claiming exactly at N (Req 7.4) and hold there.
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    concurrency: fc.integer({ min: 1, max: 8 }),
                    cycles: fc.integer({ min: 1, max: 20 }),
                    totalJobs: fc.integer({ min: 1, max: 60 }),
                }),
                async ({ concurrency, cycles, totalJobs }) => {
                    const tracker = new ConcurrencyTracker();
                    const queue: PosterJob[] = [];
                    for (let i = 1; i <= totalJobs; i += 1) queue.push(makeJob(i));

                    const state = createWorkerState();
                    const deps: TickDeps = {
                        concurrency,
                        staleProcessingSeconds: 300,
                        reclaimStaleProcessing: async () => 0,
                        claimJobs: makeClaimJobs(queue),
                        processJob: tracker.makeProcessJob(),
                    };

                    // Never resolve between ticks: in-flight jobs pile up to the
                    // ceiling and stay there.
                    for (let c = 0; c < cycles; c += 1) {
                        await tick(state, deps);
                        expect(state.inFlight).toBeLessThanOrEqual(concurrency);
                        expect(tracker.live).toBeLessThanOrEqual(concurrency);
                    }

                    // With unlimited pending work, the worker saturates at exactly
                    // min(N, totalJobs) and never beyond.
                    expect(tracker.max).toBeLessThanOrEqual(concurrency);
                    expect(state.inFlight).toBe(Math.min(concurrency, totalJobs));

                    await tracker.resolveAll();
                    expect(state.inFlight).toBe(0);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
