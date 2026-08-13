import { Pool } from 'pg';

let _pool: Pool | undefined;

function getPool(): Pool {
  if (!_pool) {
    // Try connection string first
    const connectionString = process.env.DATABASE_URL || process.env.DB_DATABASE_URL || process.env.DB_POSTGRES_URL;

    if (connectionString) {
      // Remove channel_binding param which can cause issues with the pg library
      const cleanedConnectionString = connectionString.replace(/[?&]channel_binding=[^&]*/g, '').replace(/\?&/, '?');
      _pool = new Pool({
        connectionString: cleanedConnectionString,
        ssl: { rejectUnauthorized: false },
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
        ssl: { rejectUnauthorized: false },
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
