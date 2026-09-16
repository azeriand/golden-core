// Poster_Worker Postgres pool.
//
// The worker talks to the SAME Neon database as the Vercel app, but as an
// independent, long-running process it owns its own `pg` Pool. The connection
// string is read from the environment ONLY, via loadConfig() (Requirements 6.3,
// 14.1). The secret value is used to construct the Pool but is never logged or
// returned to any caller (Requirements 14.2, 14.3, 14.4) -- logging lives in
// logger.ts and only ever emits non-secret context.
//
// SSL handling mirrors the app's lib/db.ts: Neon requires TLS, and the
// `channel_binding` connection parameter is stripped because it can break the
// `pg` driver's negotiation.

import { Pool } from 'pg';
import { loadConfig } from './config.js';

/**
 * Remove the `channel_binding` query parameter from a Postgres connection
 * string. Neon connection strings sometimes include `channel_binding=require`,
 * which the `pg` library does not negotiate cleanly. Stripping it keeps the rest
 * of the URL (including credentials) intact. The returned value is still a
 * secret and must never be logged.
 */
function stripChannelBinding(connectionString: string): string {
  return connectionString
    .replace(/[?&]channel_binding=[^&]*/g, '')
    .replace(/\?&/, '?');
}

let _pool: Pool | undefined;

/**
 * Lazily construct and return the shared worker Pool. The DATABASE_URL secret is
 * sourced exclusively from the environment through loadConfig(); loadConfig
 * throws a secret-free ConfigError if it is missing, so the worker fails fast at
 * startup rather than mid-processing (Requirements 6.3, 14.1).
 *
 * The Pool is a singleton: repeated calls return the same instance so the worker
 * reuses connections across poll cycles instead of opening a new pool per tick.
 */
export function getPool(): Pool {
  if (!_pool) {
    const { databaseUrl } = loadConfig();
    _pool = new Pool({
      connectionString: stripChannelBinding(databaseUrl),
      // Neon terminates TLS at the pooler; rejectUnauthorized:false matches the
      // app's lib/db.ts and avoids self-signed-chain rejections.
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

/**
 * Close the shared Pool and clear the singleton. Called during graceful shutdown
 * (SIGTERM/SIGINT) after in-flight jobs finish so the process can exit cleanly
 * without leaking connections.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    const pool = _pool;
    _pool = undefined;
    await pool.end();
  }
}
