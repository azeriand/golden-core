// Poster_Worker poll loop, bounded concurrency, and graceful shutdown.
//
// This is the worker's ENTRY POINT and the top of its runtime. It ties together
// the queue state machine (queue.ts) and the per-job pipeline (process-job.ts)
// into a repeating Poll_Cycle, while enforcing the two runtime invariants the
// requirements demand:
//
//   - Bounded_Concurrency: never process more than N jobs simultaneously, and
//     never claim while inFlight == N (Requirements 7.3, 7.4).
//   - Graceful shutdown: on SIGTERM/SIGINT stop claiming and wait for in-flight
//     jobs to finish so no job is abandoned mid-write (design "Poll loop").
//
// DESIGN FOR TESTABILITY: the heart of the loop is a single `tick()` that is
// pure with respect to its injected dependencies (reclaim, claim, process) and
// a shared, mutable `WorkerState` holding the in-flight count. `tick` performs
// exactly one Poll_Cycle body -- reclaim stale -> compute free capacity
// (N - inFlight) -> claim up to that many -> dispatch each to processing -- and
// returns the promises for the jobs it dispatched. Because it takes plain
// function dependencies and a state object, property tests 10.2 (bounded
// concurrency) and 10.3 (failure isolation) can drive many ticks deterministically
// with mocked claim/process and assert the invariants, without timers, sockets,
// or a real database.
//
// SECRETS: this module handles only ids, counts, and injected functions. It
// never reads, returns, or logs DATABASE_URL / BLOB_READ_WRITE_TOKEN. The
// startup line logs only non-secret operational settings (Requirements 14.3,
// 14.4, 16.1). The Pool that ultimately uses DATABASE_URL is built in db.ts.

import { loadConfig, type WorkerConfig } from './config.js';
import { closePool } from './db.js';
import { logger } from './logger.js';
import {
  claimJobs as defaultClaimJobs,
  reclaimStaleProcessing as defaultReclaimStaleProcessing,
  type PosterJob,
} from './queue.js';
import { processJob as defaultProcessJob } from './process-job.js';

/**
 * Mutable runtime state shared across ticks. `inFlight` is the number of jobs
 * currently being processed by THIS worker; it is incremented when a job is
 * dispatched and decremented when its processing settles (success OR failure),
 * so it is the single source of truth for bounded concurrency (Req 7.3, 7.4).
 * `stopping` flips to true on shutdown so ticks stop claiming new work while
 * letting in-flight jobs drain (design "Graceful shutdown").
 */
export interface WorkerState {
  inFlight: number;
  stopping: boolean;
}

/** Create a fresh, idle worker state. */
export function createWorkerState(): WorkerState {
  return { inFlight: 0, stopping: false };
}

/**
 * Injectable collaborators for a tick. Defaults wire the real queue/pipeline
 * functions; tests override any subset to drive ticks deterministically with
 * mocked claim/process (enables property tests 10.2 and 10.3).
 */
export interface TickDeps {
  /** Bounded concurrency N (>= 1) and the stale-processing reclaim timeout. */
  readonly concurrency: number;
  readonly staleProcessingSeconds: number;
  /** Return stuck 'processing' jobs to 'pending'; resolves with the count. */
  readonly reclaimStaleProcessing: (timeoutSeconds: number) => Promise<number>;
  /** Claim up to `limit` due 'pending' jobs, flipping them to 'processing'. */
  readonly claimJobs: (limit: number) => Promise<PosterJob[]>;
  /** Process a single claimed job end to end (never throws for a normal fail). */
  readonly processJob: (job: PosterJob) => Promise<void>;
}

/**
 * Build the default tick dependencies from the resolved config. The real queue
 * and pipeline functions read/write the shared Pool internally, so a tick needs
 * only the two numeric tunables plus the three effectful functions.
 */
export function defaultTickDeps(config: WorkerConfig): TickDeps {
  return {
    concurrency: config.concurrency,
    staleProcessingSeconds: config.staleProcessingSeconds,
    reclaimStaleProcessing: (timeoutSeconds) =>
      defaultReclaimStaleProcessing(timeoutSeconds),
    claimJobs: (limit) => defaultClaimJobs(limit),
    // Bind the pipeline to its default (real) deps so a tick just passes a job.
    processJob: (job) => defaultProcessJob(job),
  };
}

/**
 * Run exactly ONE Poll_Cycle body against the shared state and return the
 * promises for every job dispatched this cycle. This function is intentionally
 * small and dependency-injected so it is deterministic in tests.
 *
 * Steps (design "Poll loop", Requirements 7.3, 7.4, 10.2):
 *   1. Reclaim stale 'processing' jobs back to 'pending' so a crashed worker's
 *      claims are recoverable (Req 10.2). Reclaim runs every cycle regardless of
 *      capacity because it frees work for all workers.
 *   2. If the worker is stopping, do NOT claim any new work -- only in-flight
 *      jobs (already counted) are allowed to finish (graceful shutdown).
 *   3. Compute free capacity = N - inFlight. If it is <= 0, skip claiming this
 *      cycle so simultaneous processing never exceeds N (Req 7.4).
 *   4. Claim up to `freeCapacity` due jobs (Req 7.1, via queue.ts).
 *   5. Dispatch each claimed job: increment inFlight BEFORE awaiting so a
 *      concurrent/next tick sees the reduced capacity, then decrement when the
 *      job settles (finally) whether it succeeded or failed. processJob is
 *      designed never to throw for a normal processing failure, but the finally
 *      guarantees the count is corrected even against an unexpected throw so the
 *      worker cannot "leak" capacity (Req 7.3).
 *
 * Returns the dispatched promises so a caller (the loop or a test) can await the
 * batch when it wants to drain, e.g. during shutdown.
 */
export async function tick(
  state: WorkerState,
  deps: TickDeps,
): Promise<Promise<void>[]> {
  // 1. Reclaim stale processing jobs (Req 10.2). Failures here must not kill the
  //    loop; log and continue so a transient reclaim error doesn't stall polling.
  try {
    const reclaimed = await deps.reclaimStaleProcessing(
      deps.staleProcessingSeconds,
    );
    if (reclaimed > 0) {
      logger.reclaim(reclaimed);
    }
  } catch (err) {
    logger.info('reclaim failed', { error: describeTickError(err) });
  }

  // 2 + 3. While stopping, claim nothing. Otherwise compute free capacity and
  //        skip claiming when at the concurrency ceiling (Req 7.4).
  if (state.stopping) {
    return [];
  }
  const freeCapacity = deps.concurrency - state.inFlight;
  if (freeCapacity <= 0) {
    return [];
  }

  // 4. Claim up to the free capacity (Req 7.1). A claim error is logged and the
  //    cycle yields no work rather than crashing the loop.
  let claimed: PosterJob[];
  try {
    claimed = await deps.claimJobs(freeCapacity);
  } catch (err) {
    logger.info('claim failed', { error: describeTickError(err) });
    return [];
  }

  // 5. Dispatch each claimed job, tracking in-flight count so simultaneous
  //    processing never exceeds N (Req 7.3, 7.4).
  const dispatched: Promise<void>[] = [];
  for (const job of claimed) {
    state.inFlight += 1;
    const settled = Promise.resolve(deps.processJob(job)).finally(() => {
      state.inFlight -= 1;
    });
    dispatched.push(settled);
  }
  return dispatched;
}

/**
 * Normalize an unexpected tick-level error to a short, non-secret string for the
 * info log. Mirrors logger.describeError's intent but stays local so the loop's
 * own error handling never risks logging a secret-bearing object (Req 14.4).
 */
function describeTickError(err: unknown): string {
  if (err instanceof Error) {
    return err.message ? `${err.name}: ${err.message}` : err.name;
  }
  return 'Unknown error';
}

/** A running loop handle: awaiting `done` resolves after graceful shutdown. */
export interface RunningLoop {
  /** The shared worker state (exposed for observability/testing). */
  readonly state: WorkerState;
  /** Request a graceful stop: stop claiming and drain in-flight jobs. */
  stop: () => void;
  /** Resolves once the loop has stopped and all in-flight jobs have drained. */
  readonly done: Promise<void>;
}

/**
 * Start the repeating poll loop. Each iteration runs one `tick` and then sleeps
 * `pollIntervalMs` before the next, so the worker polls continuously
 * (Requirement 6.4). In-flight promises are tracked across iterations so a
 * graceful stop can await them all before resolving.
 *
 * The loop keeps running until `stop()` is called (or a shutdown signal, wired
 * in main()). After `stop()`, `tick` claims no new work; the loop then awaits
 * every tracked in-flight promise so no job is abandoned mid-write, closes the
 * Pool, and resolves `done`.
 */
export function startLoop(
  deps: TickDeps,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): RunningLoop {
  const state = createWorkerState();
  // Track every dispatched promise so shutdown can wait for the full set, not
  // just the current tick's batch.
  const inFlightPromises = new Set<Promise<void>>();

  const done = (async () => {
    while (!state.stopping) {
      const dispatched = await tick(state, deps);
      for (const p of dispatched) {
        inFlightPromises.add(p);
        // Self-remove once settled to keep the set bounded.
        void p.finally(() => inFlightPromises.delete(p));
      }
      if (state.stopping) {
        break;
      }
      await sleep(pollIntervalMs);
    }
    // Graceful drain: wait for all in-flight jobs to finish so none is abandoned
    // mid-write (design "Graceful shutdown"). processJob never throws for normal
    // failures, but allSettled guards against any unexpected rejection so drain
    // always completes.
    await Promise.allSettled([...inFlightPromises]);
  })();

  return {
    state,
    stop: () => {
      state.stopping = true;
    },
    done,
  };
}

/** Default sleep used between poll cycles; overridable in tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process entry point. Loads config (fails fast with a secret-free error if a
 * secret is missing), logs a secret-free startup line with only operational
 * settings (Requirements 6.4, 16.1), starts the poll loop, and wires
 * SIGTERM/SIGINT to a graceful shutdown that drains in-flight jobs and closes
 * the Pool before exiting.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Secret-free startup line: only non-secret operational tunables (Req 16.1).
  // DATABASE_URL / BLOB_READ_WRITE_TOKEN are deliberately NOT included.
  logger.startup({
    concurrency: config.concurrency,
    poll_interval_ms: config.pollIntervalMs,
    max_attempts: config.maxAttempts,
    stale_processing_seconds: config.staleProcessingSeconds,
    max_dimension: config.maxDimension,
    backoff_base_seconds: config.backoffBaseSeconds,
  });

  const loop = startLoop(defaultTickDeps(config), config.pollIntervalMs);

  // Graceful shutdown: on the first signal, stop claiming and drain; on receipt
  // ensure we only trigger the drain once.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    loop.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Wait for the loop to fully drain, then release DB connections.
  await loop.done;
  await closePool();
  logger.info('worker stopped');
}

// Only run main() when this module is the process entry point, so importing it
// from tests (to exercise `tick`/`startLoop`) does not start the real loop or
// touch the database. Under NodeNext ESM, compare the resolved module URL to the
// invoked script.
const isEntryPoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntryPoint) {
  main().catch((err) => {
    // Fail fast on a fatal startup error (e.g. missing secret). Use the logger's
    // secret-free info channel; never print the raw error object which could
    // embed a connection string.
    logger.info('worker fatal error', { error: describeTickError(err) });
    process.exitCode = 1;
  });
}
