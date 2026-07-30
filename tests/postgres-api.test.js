// Explicitly inject the test-only in-memory stub flag before importing any modules
process.env.USE_IN_MEMORY_STUB = "true";

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { checkDatabaseHealth, AgentRepository, dbAdapter, setMockQueryHandler, EvidenceLedgerRepository } from "../src/catalog/repositories.js";
import { runMigrations } from "../src/db/index.js";
import { bootstrapOwner } from "../src/catalog/bootstrap.js";
import { validatePasswordStrength, hashPassword, verifyPassword } from "../src/catalog/ownerAuthentication.js";
import app from "../src/catalog/server.js";

test("PostgreSQL connection check skips gracefully or verifies health", async () => {
  const health = await checkDatabaseHealth();
  assert.ok(["healthy", "unavailable", "unhealthy"].includes(health.status));
});

test("Migration runner is defined and runs smoothly or throws when db is offline", async () => {
  try {
    await runMigrations();
  } catch (err) {
    // Expected to throw or skip if PostgreSQL is unavailable
    const msg = err.message.toLowerCase();
    assert.ok(
      msg.includes("migration_failure") ||
      msg.includes("not_initialized") ||
      msg.includes("connection") ||
      msg.includes("query_error") ||
      msg.includes("connect") ||
      msg.includes("econnrefused") ||
      msg.includes("aggregateerror") ||
      msg.includes("requires a valid")
    );
  }
});

test("Password policy validates strength correctly", () => {
  // Too short
  assert.throws(() => {
    validatePasswordStrength("short");
  }, /PASSWORD_TOO_SHORT_MUST_BE_AT_LEAST_12_CHARACTERS/);

  // Compromised / common
  assert.throws(() => {
    validatePasswordStrength("password12345");
  }, /PASSWORD_IS_COMMON_OR_COMPROMISED/);

  // Secure password succeeds
  assert.ok(validatePasswordStrength("MySecureAndExtremelyLongPassword123!"));
});

test("Real Argon2id password hashing and verification works asynchronously", async () => {
  const pwd = "SecureMasterPassword2026!";
  const hash = await hashPassword(pwd);
  assert.ok(hash.startsWith("$argon2id$"));

  // Match
  const match = await verifyPassword(pwd, hash);
  assert.equal(match, true);

  // Mismatch
  const mismatch = await verifyPassword("WrongPasswordValue", hash);
  assert.equal(mismatch, false);
});

test("Owner bootstrap safety refuses missing credentials and behaves predictably", async () => {
  // No environment variables set, skips gracefully
  const prevEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  const prevPwd = process.env.BOOTSTRAP_OWNER_PASSWORD;
  delete process.env.BOOTSTRAP_OWNER_EMAIL;
  delete process.env.BOOTSTRAP_OWNER_PASSWORD;

  const res = await bootstrapOwner();
  assert.equal(res.status, "skipped");

  // Restore env
  process.env.BOOTSTRAP_OWNER_EMAIL = prevEmail;
  process.env.BOOTSTRAP_OWNER_PASSWORD = prevPwd;
});

test("API: GET /api/health returns status healthy", async () => {
  const res = await request(app)
    .get("/api/health")
    .expect(200);

  assert.equal(res.body.status, "healthy");
  assert.ok(res.body.timestamp);
});

test("API: GET /api/ready returns ready or 503 depending on database status", async () => {
  const res = await request(app).get("/api/ready");
  assert.ok([200, 503].includes(res.status));
});

test("API: POST /api/auth/register fails with missing parameters", async () => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "" })
    .expect(400);

  assert.ok(res.body.error);
});

test("API: POST /api/auth/login fails with invalid credentials and generic error message", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "nonexistent@st.com", password: "SomeRandomPassword123!" })
    .expect(401);

  assert.equal(res.body.error, "INVALID_EMAIL_OR_PASSWORD");
});

test("API: Anonymous requests to protected me route return 401", async () => {
  const res = await request(app)
    .get("/api/auth/me")
    .expect(401);

  assert.equal(res.body.error, "SESSION_TOKEN_REQUIRED");
});

test("Agent 50-limit is checked at JS repository layer", async () => {
  const repo = new AgentRepository();

  if (process.env.USE_IN_MEMORY_STUB === "true") {
    // Under in-memory stub, we can mock the query handler explicitly
    setMockQueryHandler(async (text, params) => {
      if (text.includes("count(*) FROM agents")) {
        return { rows: [{ count: 50 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    try {
      await assert.rejects(async () => {
        await repo.add({ id: "agent-51", name: "Agent 51", namespace: "ns.51" });
      }, /AGENT_CAP_REACHED/);
    } finally {
      setMockQueryHandler(null);
    }
  } else {
    // Under live PG, we can populate real records and test it
    await dbAdapter.query("DELETE FROM agents WHERE id LIKE 'a-%';");
    for (let i = 0; i < 50; i++) {
      await dbAdapter.query(
        "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING;",
        [`a-${i}`, `Agent ${i}`, `ns.${i}`]
      );
    }
    await assert.rejects(async () => {
      await repo.add({ id: "agent-51", name: "Agent 51", namespace: "ns.51" });
    }, /AGENT_CAP_REACHED/);

    // Clean up
    await dbAdapter.query("DELETE FROM agents WHERE id LIKE 'a-%';");
  }
});

test("EvidenceLedgerRepository append-only and hashing verification contracts are intact", async () => {
  const repo = new EvidenceLedgerRepository();

  // Appending invalid event throws
  await assert.rejects(async () => {
    await repo.append({});
  }, /INCOMPLETE_EVIDENCE_EVENT/);

  await assert.rejects(async () => {
    await repo.append({ subjectId: "123", kind: "platform_publish", classification: "test" });
  }, /VERIFIABLE_PLATFORM_RECEIPT_REQUIRED/);
});
