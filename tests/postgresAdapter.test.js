import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter, createPostgresAdapter, getPoolConfig, sanitizeError } from '../src/db/postgresAdapter.js';

test('PostgresAdapter - Pool Configuration', async (t) => {
  await t.test('resolves default pool configuration safely', () => {
    const config = getPoolConfig({});
    assert.equal(config.max, 10);
    assert.equal(config.idleTimeoutMillis, 30000);
    assert.equal(config.connectionTimeoutMillis, 5000);
    assert.equal(config.statement_timeout, 30000);
    assert.equal(config.ssl, false);
  });

  await t.test('accepts DATABASE_URL and config overrides', () => {
    const config = getPoolConfig({
      connectionString: 'postgresql://testuser:testpass@localhost:5432/testdb',
      max: 25,
      ssl: { rejectUnauthorized: false },
    });
    assert.equal(config.connectionString, 'postgresql://testuser:testpass@localhost:5432/testdb');
    assert.equal(config.max, 25);
    assert.equal(config.ssl.rejectUnauthorized, false);
  });

  await t.test('resolves individual host/port/user/password variables', () => {
    const config = getPoolConfig({
      host: 'pg.example.com',
      port: 5433,
      user: 'admin',
      password: 'secretpassword',
      database: 'production_db',
    });
    assert.equal(config.host, 'pg.example.com');
    assert.equal(config.port, 5433);
    assert.equal(config.user, 'admin');
    assert.equal(config.password, 'secretpassword');
    assert.equal(config.database, 'production_db');
  });
});

test('PostgresAdapter - Secret Redaction', async (t) => {
  await t.test('redacts password in postgres URI errors', () => {
    const err = new Error('Connection failed to postgresql://st_user:SuperSecretPassword123@db.example.com:5432/st_db');
    const sanitized = sanitizeError(err);
    assert.ok(!sanitized.message.includes('SuperSecretPassword123'));
    assert.ok(sanitized.message.includes('[REDACTED]'));
    assert.ok(sanitized.message.includes('st_user'));
  });

  await t.test('redacts vault secret locators', () => {
    const err = new Error('Failed to resolve locator vault://st/secrets/db-pass for database auth');
    const sanitized = sanitizeError(err);
    assert.ok(!sanitized.message.includes('vault://st/secrets/db-pass'));
    assert.ok(sanitized.message.includes('[REDACTED_LOCATOR]'));
  });

  await t.test('handles non-error inputs gracefully', () => {
    const sanitized = sanitizeError(null);
    assert.equal(sanitized.message, 'Unknown database error');
  });
});

test('PostgresAdapter - Query Execution & Parameterized Inputs', async (t) => {
  await t.test('delegates query and parameters to underlying pool', async () => {
    let capturedText = null;
    let capturedParams = null;

    const mockPool = {
      query: async (text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rows: [{ id: 1, name: 'Test Agent' }], rowCount: 1 };
      },
      on: () => {},
      end: async () => {},
    };

    const adapter = new PostgresAdapter({}, mockPool);
    const result = await adapter.query('SELECT * FROM agents WHERE id = $1', ['agent-123']);

    assert.equal(capturedText, 'SELECT * FROM agents WHERE id = $1');
    assert.deepEqual(capturedParams, ['agent-123']);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].name, 'Test Agent');

    await adapter.closePool();
  });
});

test('PostgresAdapter - Transactions (Commit & Rollback)', async (t) => {
  await t.test('executes BEGIN, callback, and COMMIT on success', async () => {
    const executedQueries = [];
    let released = false;

    const mockClient = {
      query: async (text) => {
        executedQueries.push(text);
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    };

    const mockPool = {
      connect: async () => mockClient,
      on: () => {},
      end: async () => {},
    };

    const adapter = new PostgresAdapter({}, mockPool);

    const result = await adapter.withTransaction(async (client) => {
      await client.query('INSERT INTO test (val) VALUES (1)');
      return 'SUCCESS_DATA';
    });

    assert.equal(result, 'SUCCESS_DATA');
    assert.deepEqual(executedQueries, [
      'BEGIN',
      'INSERT INTO test (val) VALUES (1)',
      'COMMIT',
    ]);
    assert.equal(released, true);

    await adapter.closePool();
  });

  await t.test('executes ROLLBACK and releases client on callback failure', async () => {
    const executedQueries = [];
    let released = false;

    const mockClient = {
      query: async (text) => {
        executedQueries.push(text);
        if (text === 'FAIL_HERE') {
          throw new Error('Simulated query failure with password postgresql://user:secretpass@host/db');
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    };

    const mockPool = {
      connect: async () => mockClient,
      on: () => {},
      end: async () => {},
    };

    const adapter = new PostgresAdapter({}, mockPool);

    await assert.rejects(
      async () => {
        await adapter.withTransaction(async (client) => {
          await client.query('INSERT INTO test (val) VALUES (1)');
          await client.query('FAIL_HERE');
        });
      },
      (err) => {
        assert.ok(err.message.includes('Simulated query failure'));
        assert.ok(!err.message.includes('secretpass'));
        return true;
      }
    );

    assert.deepEqual(executedQueries, [
      'BEGIN',
      'INSERT INTO test (val) VALUES (1)',
      'FAIL_HERE',
      'ROLLBACK',
    ]);
    assert.equal(released, true);

    await adapter.closePool();
  });
});

test('PostgresAdapter - Graceful Shutdown', async (t) => {
  await t.test('ends pool gracefully and rejects queries after close', async () => {
    let poolEnded = false;
    const mockPool = {
      query: async () => ({ rows: [] }),
      on: () => {},
      end: async () => {
        poolEnded = true;
      },
    };

    const adapter = new PostgresAdapter({}, mockPool);
    await adapter.closePool();

    assert.equal(poolEnded, true);
    assert.equal(adapter.isClosed, true);

    await assert.rejects(
      async () => {
        await adapter.query('SELECT 1');
      },
      /PostgreSQL pool is closed/
    );
  });
});
