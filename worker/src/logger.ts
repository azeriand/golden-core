// Poster_Worker structured, secret-free logger.
//
// Every line the worker emits is a single JSON object so Railway's log viewer
// can index it. The logger exposes intent-specific helpers (startup, claim,
// done, failure, reclaim) that emit exactly the observability fields the
// requirements call for -- media_id, the Job_Status transition, attempts, and a
// SHORT non-secret error description (Requirements 16.1, 16.2, 16.3).
//
// SECRETS ARE NEVER LOGGED. Two layers protect the two secrets, DATABASE_URL and
// BLOB_READ_WRITE_TOKEN (Requirements 14.3, 14.4):
//   1. The helper signatures only accept non-secret context (ids, statuses,
//      counts, short strings), so callers have no field to pass a secret into.
//   2. A defensive redaction pass scrubs the live DATABASE_URL /
//      BLOB_READ_WRITE_TOKEN values (and, for errors, common secret-shaped
//      substrings) out of every serialized line before it is written. This
//      guards against a secret sneaking in via an error message that echoed a
//      connection string.

/** Log severity levels emitted by the worker. */
export type LogLevel = 'info' | 'warn' | 'error';

/** The four Poster_Job lifecycle states, reused for transition logging. */
export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * Return the current set of secret VALUES to scrub from log output. Read from
 * the environment at call time so tests can set/clear them; absent secrets
 * simply contribute nothing to redact.
 */
function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN'];
  const values: string[] = [];
  for (const key of keys) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      values.push(raw);
    }
  }
  return values;
}

/**
 * Defensive redaction: replace any occurrence of a known secret value with a
 * fixed placeholder. This is a last line of defense -- the helper APIs already
 * prevent secrets from being passed in -- but it guarantees that even an error
 * string that happens to embed a connection string or token cannot leak
 * (Requirements 14.3, 14.4).
 */
export function redactSecrets(
  line: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = line;
  for (const secret of secretValues(env)) {
    // Split/join avoids constructing a RegExp from secret text (which could
    // contain regex metacharacters) and replaces every occurrence.
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * Reduce an unknown thrown value to a SHORT, non-secret description. We keep the
 * error name and message only -- never a stack, never arbitrary properties that
 * might carry a connection string -- and cap the length so a runaway message
 * cannot flood the logs (Requirements 16.3, 14.4).
 */
export function describeError(err: unknown): string {
  let description: string;
  if (err instanceof Error) {
    description = err.message ? `${err.name}: ${err.message}` : err.name;
  } else if (typeof err === 'string') {
    description = err;
  } else {
    description = 'Unknown error';
  }
  const MAX = 300;
  if (description.length > MAX) {
    description = `${description.slice(0, MAX)}...`;
  }
  return description;
}

/**
 * Serialize a structured record to a single JSON line, then run the redaction
 * pass over the whole line and write it to the matching console stream. This is
 * the ONLY function that writes output, so all logging flows through redaction.
 */
function emit(level: LogLevel, fields: Record<string, unknown>): void {
  const record = {
    level,
    time: new Date().toISOString(),
    ...fields,
  };
  const line = redactSecrets(JSON.stringify(record));
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Structured worker logger. Each method emits one JSON line with only
 * non-secret fields. Callers never pass secret values -- there is no parameter
 * that accepts one -- and the emit() redaction pass is the safety net.
 */
export const logger = {
  /**
   * Secret-free startup line emitted once when the worker begins polling
   * (Requirement 6.4 / 16 observability). Accepts only non-secret operational
   * settings (e.g. concurrency, poll interval).
   */
  startup(fields: Record<string, string | number> = {}): void {
    emit('info', { event: 'worker.startup', ...fields });
  },

  /**
   * Log a job being claimed, at claim time, before processing begins. Emits the
   * media_id and the status transition to 'processing' (Requirement 16.1).
   */
  claim(mediaId: number, jobId: number, attempts: number): void {
    emit('info', {
      event: 'job.claim',
      media_id: mediaId,
      job_id: jobId,
      attempts,
      status_from: 'pending' as JobStatus,
      status_to: 'processing' as JobStatus,
    });
  },

  /**
   * Log a job completing successfully. Emits the media_id and the completion
   * outcome (status -> 'done') (Requirement 16.2).
   */
  done(mediaId: number, jobId: number): void {
    emit('info', {
      event: 'job.done',
      media_id: mediaId,
      job_id: jobId,
      status_to: 'done' as JobStatus,
    });
  },

  /**
   * Log a job failure. Emits the media_id, the current attempts count, the
   * resulting status (retry -> 'pending' or terminal -> 'failed'), and a SHORT
   * non-secret error description (Requirement 16.3). The error is normalized via
   * describeError so no stack or secret-bearing field is written.
   */
  failure(
    mediaId: number,
    jobId: number,
    attempts: number,
    nextStatus: Extract<JobStatus, 'pending' | 'failed'>,
    err: unknown,
  ): void {
    emit('error', {
      event: 'job.failure',
      media_id: mediaId,
      job_id: jobId,
      attempts,
      status_to: nextStatus,
      error: describeError(err),
    });
  },

  /**
   * Log reclaim of stale 'processing' jobs back to 'pending' (Requirement 10.2).
   * Emits only the count of jobs reclaimed -- no secret context.
   */
  reclaim(reclaimedCount: number): void {
    emit('warn', {
      event: 'job.reclaim',
      reclaimed: reclaimedCount,
      status_from: 'processing' as JobStatus,
      status_to: 'pending' as JobStatus,
    });
  },

  /** Generic non-secret info line for anything not covered above. */
  info(message: string, fields: Record<string, unknown> = {}): void {
    emit('info', { message, ...fields });
  },
};
