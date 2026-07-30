import pg from 'pg';

const { Pool } = pg;

/**
 * Safely sanitizes error messages and stack traces to ensure connection strings,
 * passwords, or secret locators are never exposed in logs or test output.
 * 
 * @param {Error|unknown} error - The error to sanitize
 * @returns {Error} A new error instance with sanitized message and stack trace
 */
export function sanitizeError(error) {
  if (!error) return new Error('Unknown database error');

  const rawMessage = typeof error === 'string' ? error : error.message || String(error);
  const rawStack = typeof error === 'object' && error !== null && error.stack ? error.stack : '';

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

  const sanitizedMessage = sanitizeText(rawMessage);

  if (typeof error === 'object' && error !== null) {
    error.message = sanitizedMessage;
    if (error.stack) error.stack = sanitizeText(rawStack);
    if (error.detail) error.detail = sanitizeText(error.detail);
    if (error.hint) error.hint = sanitizeText(error.hint);
    return error;
  }

  return new Error(sanitizedMessage);
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
        const sanitized = sanitizeError(err);
        if (process.env.NODE_ENV === 'development') {
          console.error('[PostgresAdapter] Idle client error:', sanitized.message);
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
