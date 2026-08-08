import pg from 'pg';

const { Pool } = pg;

/**
 * Safely sanitizes error messages and stack traces to ensure connection strings,
 * passwords, or secret locators are never exposed in logs or test output.
 * Preserves custom error prototypes while redacting sensitive values from all loggable error fields,
 * including relevant custom properties—not only message, stack, detail, and hint.
 *
 * @param {Error|unknown} error - The error to sanitize
 * @returns {Error} The sanitized error (preserving the custom prototype)
 */
export function sanitizeError(error) {
  if (!error) return new Error('Unknown database error');

  // Regexp patterns to redact passwords in URIs (postgresql://user:pass@host) and env vars
  const uriPasswordRegex = /(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi;
  const passwordKeyRegex = /(password\s*[:=]\s*['"]?)[^'"\s,;]+(['"]?)/gi;
  const secretLocatorRegex = /(vault:\/\/[^\s'"]+)/gi;

  const sanitizeText = (text) => {
    if (!text) return '';
    return text
      .replace(uriPasswordRegex, '$1[REDACTED]$3')
      .replace(passwordKeyRegex, '$1[REDACTED]$2')
      .replace(secretLocatorRegex, '[REDACTED_LOCATOR]');
  };

  const seen = new Set();

  const sanitizeValue = (val) => {
    if (!val) return val;
    if (typeof val === 'string') {
      return sanitizeText(val);
    }
    if (typeof val === 'object' || typeof val === 'function') {
      if (seen.has(val)) return val;

      if (val instanceof Error) {
        return sanitizeErrorObject(val);
      }

      seen.add(val);

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          val[i] = sanitizeValue(val[i]);
        }
        return val;
      }
      // General object property recursion
      const keys = Reflect.ownKeys(val);
      for (const key of keys) {
        try {
          const desc = Object.getOwnPropertyDescriptor(val, key);
          if (!desc || desc.writable || desc.set) {
            val[key] = sanitizeValue(val[key]);
          }
        } catch (e) {
          // Ignore write/access descriptor errors
        }
      }
    }
    return val;
  };

  const sanitizeErrorObject = (err) => {
    if (!err) return err;
    if (seen.has(err)) return err;
    seen.add(err);

    // Standard fields with fallback try/catch
    if (typeof err.message === 'string') {
      try {
        err.message = sanitizeText(err.message);
      } catch (e) {}
    }
    if (typeof err.stack === 'string') {
      try {
        err.stack = sanitizeText(err.stack);
      } catch (e) {}
    }

    // Traverse all keys (including non-enumerable, symbol keys, etc.)
    const keys = Reflect.ownKeys(err);
    for (const key of keys) {
      if (key === 'message' || key === 'stack') continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(err, key);
        if (!desc || desc.writable || desc.set) {
          err[key] = sanitizeValue(err[key]);
        }
      } catch (e) {
        // Ignore descriptor/write errors
      }
    }
    return err;
  };

  if (typeof error === 'object' && error !== null) {
    return sanitizeErrorObject(error);
  }

  // If a primitive string error was passed, return a standard Error with sanitized message
  return new Error(sanitizeText(String(error)));
}

/**
 * Resolves connection configuration from environment variables or explicitly passed config.
 * Supports DATABASE_URL or individual PG* / POSTGRES_* environment variables.
 *
 * @param {Object} [configOverride={}]
 * @returns {Object} Clean pg.Pool configuration object
 */
export function getPoolConfig(configOverride = {}) {
  const connectionString = configOverride.connectionString ||
                           process.env.DATABASE_URL ||
                           process.env.POSTGRES_URL;

  const host = configOverride.host || process.env.PGHOST || process.env.POSTGRES_HOST;
  const port = configOverride.port || (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : (process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : undefined));
  const user = configOverride.user || process.env.PGUSER || process.env.POSTGRES_USER;
  const password = configOverride.password || process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
  const database = configOverride.database || process.env.PGDATABASE || process.env.POSTGRES_DB;

  const max = configOverride.max ?? (process.env.PGMAXPOOL ? parseInt(process.env.PGMAXPOOL, 10) : 10);
  const idleTimeoutMillis = configOverride.idleTimeoutMillis ?? (process.env.PGIDLETIMEOUT ? parseInt(process.env.PGIDLETIMEOUT, 10) : 30000);
  const connectionTimeoutMillis = configOverride.connectionTimeoutMillis ?? (process.env.PGCONNECTTIMEOUT ? parseInt(process.env.PGCONNECTTIMEOUT, 10) : 5000);
  const statementTimeout = configOverride.statementTimeout ?? (process.env.PGSTATEMENTTIMEOUT ? parseInt(process.env.PGSTATEMENTTIMEOUT, 10) : 30000);

  let ssl = configOverride.ssl;
  if (ssl === undefined) {
    const sslMode = (process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase();
    if (sslMode === 'true' || sslMode === 'require' || sslMode === 'verify-full') {
      const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
      ssl = { rejectUnauthorized };
    } else {
      ssl = false;
    }
  }

  const poolConfig = {
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeout,
    ssl,
  };

  if (connectionString) {
    poolConfig.connectionString = connectionString;
  } else {
    if (host) poolConfig.host = host;
    if (port) poolConfig.port = port;
    if (user) poolConfig.user = user;
    if (password) poolConfig.password = password;
    if (database) poolConfig.database = database;
  }

  return poolConfig;
}

/**
 * Creates and wraps a node-postgres Pool with parameterized query support,
 * transaction execution, graceful shutdown, and secret redaction.
 */
export class PostgresAdapter {
  /**
   * @param {Object} [configOverride={}]
   * @param {Object} [customPool=null] - Optional pre-created or mock pool
   */
  constructor(configOverride = {}, customPool = null) {
    this.config = getPoolConfig(configOverride);
    this.pool = customPool || new Pool(this.config);
    this.isClosed = false;

    // Attach silent error listener on idle pool clients to prevent unhandled node crashes
    if (this.pool.on && typeof this.pool.on === 'function') {
      this.pool.on('error', (err) => {
        // Log sanitized message if needed; swallow idle connection reset errors
        if (process.env.NODE_ENV === 'development') {
          console.warn(JSON.stringify({ code: 'POSTGRES_IDLE_CLIENT_ERROR', errorName: err?.name || 'Error' }));
        }
      });
    }
  }

  /**
   * Executes a parameterized query using the pool.
   *
   * @param {string} text - SQL query text
   * @param {Array} [params=[]] - Query parameters
   * @returns {Promise<import('pg').QueryResult>}
   */
  async query(text, params = []) {
    if (this.isClosed) {
      throw sanitizeError(new Error('Cannot execute query: PostgreSQL pool is closed.'));
    }

    try {
      return await this.pool.query(text, params);
    } catch (err) {
      throw sanitizeError(err);
    }
  }

  /**
   * Executes a callback within an explicit transaction block (BEGIN...COMMIT / ROLLBACK).
   *
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async withTransaction(callback) {
    if (this.isClosed) {
      throw sanitizeError(new Error('Cannot start transaction: PostgreSQL pool is closed.'));
    }

    let client;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw sanitizeError(err);
    }

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Rollback error secondary handling
      }
      throw sanitizeError(err);
    } finally {
      if (client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  /**
   * Gracefully shuts down the connection pool.
   *
   * @returns {Promise<void>}
   */
  async closePool() {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      await this.pool.end();
    } catch (err) {
      throw sanitizeError(err);
    }
  }
}

/**
 * Factory function to create a new PostgresAdapter instance.
 *
 * @param {Object} [configOverride={}]
 * @param {Object} [customPool=null]
 * @returns {PostgresAdapter}
 */
export function createPostgresAdapter(configOverride = {}, customPool = null) {
  return new PostgresAdapter(configOverride, customPool);
}
