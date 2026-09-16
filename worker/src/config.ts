// Poster_Worker configuration loader.
//
// This module is the single source of truth for the worker's runtime settings.
// It parses everything from environment variables so the two secrets --
// DATABASE_URL (Neon connection string) and BLOB_READ_WRITE_TOKEN (Vercel Blob
// token) -- are read from the environment ONLY, never hardcoded, never returned
// to a client, and never logged (Requirements 6.3, 14.1, 14.2, 14.3, 14.4).
//
// The remaining values are operational tunables with safe defaults so the worker
// runs out-of-the-box on Railway while staying fully configurable:
//
//   | Env var                          | Meaning                                  | Req        |
//   | -------------------------------- | ---------------------------------------- | ---------- |
//   | DATABASE_URL                     | Neon connection string (secret)          | 6.3, 14.1  |
//   | BLOB_READ_WRITE_TOKEN            | Vercel Blob token (secret)               | 6.3, 14.1  |
//   | POSTER_WORKER_CONCURRENCY        | Bounded concurrency N (>=1, default 2)   | 7.3, 7.6   |
//   | POSTER_MAX_ATTEMPTS             | Max attempts before 'failed'             | 9.6        |
//   | POSTER_POLL_INTERVAL_MS         | Delay between poll cycles when idle      | 6.4        |
//   | POSTER_STALE_PROCESSING_SECONDS | Reclaim timeout for stuck 'processing'   | 10.2       |
//   | POSTER_MAX_DIMENSION           | Max poster width/height in px            | 8.2        |
//   | POSTER_BACKOFF_BASE_SECONDS     | Base for exponential backoff             | 9.2, 9.3   |
//
// IMPORTANT: getConfig() intentionally returns the secret VALUES so downstream
// modules (db.ts, the Blob upload) can use them, but the values must never be
// passed to a logger. logger.ts is responsible for emitting non-secret context
// only (Requirements 14.3, 14.4).

/**
 * Fully-resolved, validated worker configuration. Secrets are typed as plain
 * strings and are guaranteed non-empty after loadConfig() succeeds.
 */
export interface WorkerConfig {
  /** Neon Postgres connection string (secret; env-only). */
  readonly databaseUrl: string;
  /** Vercel Blob read/write token (secret; env-only). */
  readonly blobReadWriteToken: string;
  /** Bounded concurrency N: max jobs processed simultaneously (>= 1). */
  readonly concurrency: number;
  /** Max attempts before a job is marked 'failed' (>= 1). */
  readonly maxAttempts: number;
  /** Delay in milliseconds between poll cycles when idle (>= 0). */
  readonly pollIntervalMs: number;
  /** Reclaim timeout in seconds for stuck 'processing' jobs (>= 1). */
  readonly staleProcessingSeconds: number;
  /** Maximum poster width/height in pixels (>= 1). */
  readonly maxDimension: number;
  /** Base in seconds for exponential retry backoff (>= 1). */
  readonly backoffBaseSeconds: number;
}

/** Defaults applied when an optional tunable is unset or blank. */
export const CONFIG_DEFAULTS = {
  concurrency: 2,
  maxAttempts: 5,
  pollIntervalMs: 2000,
  staleProcessingSeconds: 300,
  maxDimension: 640,
  backoffBaseSeconds: 5,
} as const;

/** Raised when configuration is missing or invalid. Never contains secret values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Read a required secret from the environment. Throws a ConfigError naming only
 * the env var KEY (never a value) when the secret is missing or blank.
 */
function requireSecret(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return raw;
}

/**
 * Parse an optional positive integer tunable. Falls back to `fallback` when the
 * env var is unset/blank. Enforces `value >= min`; on a non-integer or
 * out-of-range value throws a ConfigError that includes the KEY and the offending
 * (non-secret) text so misconfiguration is diagnosable.
 */
function parseIntTunable(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, received: "${raw}"`);
  }
  if (parsed < min) {
    throw new ConfigError(`${key} must be >= ${min}, received: ${parsed}`);
  }
  return parsed;
}

/**
 * Load and validate the worker configuration from the given environment
 * (defaults to process.env). Secrets are required; tunables use documented
 * defaults. Throws a ConfigError (secret-free message) on any problem so the
 * worker fails fast at startup rather than mid-processing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = requireSecret(env, 'DATABASE_URL');
  const blobReadWriteToken = requireSecret(env, 'BLOB_READ_WRITE_TOKEN');

  // Bounded concurrency must be an integer of at least 1 (Requirements 7.3, 7.6).
  const concurrency = parseIntTunable(
    env,
    'POSTER_WORKER_CONCURRENCY',
    CONFIG_DEFAULTS.concurrency,
    1,
  );

  const maxAttempts = parseIntTunable(
    env,
    'POSTER_MAX_ATTEMPTS',
    CONFIG_DEFAULTS.maxAttempts,
    1,
  );

  // Poll interval may legitimately be 0 (poll as fast as possible), so min is 0.
  const pollIntervalMs = parseIntTunable(
    env,
    'POSTER_POLL_INTERVAL_MS',
    CONFIG_DEFAULTS.pollIntervalMs,
    0,
  );

  const staleProcessingSeconds = parseIntTunable(
    env,
    'POSTER_STALE_PROCESSING_SECONDS',
    CONFIG_DEFAULTS.staleProcessingSeconds,
    1,
  );

  const maxDimension = parseIntTunable(
    env,
    'POSTER_MAX_DIMENSION',
    CONFIG_DEFAULTS.maxDimension,
    1,
  );

  const backoffBaseSeconds = parseIntTunable(
    env,
    'POSTER_BACKOFF_BASE_SECONDS',
    CONFIG_DEFAULTS.backoffBaseSeconds,
    1,
  );

  return {
    databaseUrl,
    blobReadWriteToken,
    concurrency,
    maxAttempts,
    pollIntervalMs,
    staleProcessingSeconds,
    maxDimension,
    backoffBaseSeconds,
  };
}
