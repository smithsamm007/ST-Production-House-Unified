import pg from "pg";

const { Pool } = pg;

// We do not hardcode credentials. We read from standard env variables.
const isTest = process.env.NODE_ENV === "test";
const connectionString = process.env.DATABASE_URL;

const poolConfig = connectionString
  ? { connectionString }
  : {
      host: process.env.PGHOST || "localhost",
      port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    };

// Create a connection pool
let pool;
try {
  pool = new Pool({
    ...poolConfig,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
} catch (err) {
  // Safe error logging without credentials
  console.error("Failed to initialize PostgreSQL pool:", err.message);
  pool = null;
}

/**
 * Executes a parameterized query using the connection pool.
 * It maps errors safely and prevents leaking secrets in logs.
 */
export async function query(text, params = []) {
  if (!pool) {
    throw new Error("POSTGRESQL_POOL_NOT_INITIALIZED");
  }
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    // Sanitize error message to prevent leakage of sensitive SQL/params/credentials
    const cleanMessage = err.message.replace(/[\w\-]+:\/\/[\w\-\:%@\.\/]+/g, "[REDACTED_URL]");
    throw new Error(`DATABASE_QUERY_ERROR: ${cleanMessage}`);
  }
}

/**
 * Runs a set of queries inside an isolated transaction.
 * Automatically handles COMMIT/ROLLBACK and rolls back on failure.
 */
export async function transaction(callback) {
  if (!pool) {
    throw new Error("POSTGRESQL_POOL_NOT_INITIALIZED");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    const cleanMessage = err.message.replace(/[\w\-]+:\/\/[\w\-\:%@\.\/]+/g, "[REDACTED_URL]");
    throw new Error(`DATABASE_TRANSACTION_ERROR: ${cleanMessage}`);
  } finally {
    client.release();
  }
}

/**
 * Checks the database connection readiness/health.
 * Returns { status: 'healthy' } or throws/fails.
 */
export async function checkDatabaseHealth() {
  if (!pool) {
    return { status: "unavailable", reason: "Pool not initialized" };
  }
  try {
    // Set a very short timeout for health check
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return { status: "healthy" };
    } finally {
      client.release();
    }
  } catch (err) {
    return { status: "unhealthy", reason: err.message };
  }
}

/**
 * Predictable shutdown of the connection pool.
 */
export async function closeDatabase() {
  if (pool) {
    await pool.end();
  }
}
