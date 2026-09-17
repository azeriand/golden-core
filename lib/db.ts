import { Pool } from 'pg';
import type { ConnectionOptions } from 'tls';

let _pool: Pool | undefined;

/**
 * Build the SSL config for the pool (P1-1).
 *
 * The original code hard-coded `rejectUnauthorized: false`, which disables TLS
 * certificate validation and exposes the DB connection to MITM. This makes the
 * behavior configurable and lets production VERIFY the certificate:
 *
 *   - DB_SSL_CA set        -> validate against that CA (rejectUnauthorized: true).
 *                             Use this in production (paste the provider's CA PEM,
 *                             e.g. Neon/Vercel, into the env var).
 *   - DB_SSL_REJECT_UNAUTHORIZED === 'true' -> enforce validation with the
 *                             system trust store (no custom CA).
 *   - otherwise            -> fall back to the previous permissive behavior so
 *                             existing local/dev connections keep working. This
 *                             is intentionally the DEFAULT to avoid breaking the
 *                             current setup, but production should set one of the
 *                             two options above. See docs/plan-correcciones-produccion.md.
 */
function buildSslConfig(): ConnectionOptions {
  const ca = process.env.DB_SSL_CA;
  if (ca) {
    return { ca, rejectUnauthorized: true };
  }
  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true') {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

function getPool(): Pool {
  if (!_pool) {
    const ssl = buildSslConfig();

    // Try connection string first
    const connectionString = process.env.DATABASE_URL || process.env.DB_DATABASE_URL || process.env.DB_POSTGRES_URL;

    if (connectionString) {
      // Remove channel_binding param which can cause issues with the pg library
      const cleanedConnectionString = connectionString.replace(/[?&]channel_binding=[^&]*/g, '').replace(/\?&/, '?');
      _pool = new Pool({
        connectionString: cleanedConnectionString,
        ssl,
      });
    } else {
      // Fall back to individual env vars from Neon/Vercel integration
      const host = process.env.DB_PGHOST || process.env.DB_POSTGRES_HOST;
      const database = process.env.DB_PGDATABASE || process.env.DB_POSTGRES_DATABASE;
      const user = process.env.DB_PGUSER || process.env.DB_POSTGRES_USER;
      const password = process.env.DB_PGPASSWORD || process.env.DB_POSTGRES_PASSWORD;

      if (!host || !database || !user || !password) {
        throw new Error(
          'Database configuration missing. Set DATABASE_URL or DB_PGHOST/DB_PGDATABASE/DB_PGUSER/DB_PGPASSWORD environment variables.'
        );
      }

      _pool = new Pool({
        host,
        database,
        user,
        password,
        port: 5432,
        ssl,
      });
    }
  }
  return _pool;
}

// Use a Proxy to lazily initialize the pool on first method call
const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const instance = getPool();
    const value = (instance as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

export default pool;
