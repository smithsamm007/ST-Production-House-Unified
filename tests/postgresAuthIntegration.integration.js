import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmTotpMfa,
  enrollTotpMfa,
  generateCsrfToken,
  generateTotpCode,
  loginOwner,
  registerOwner,
  useRecoveryCode,
  validateAndRetrieveSession,
  verifyCsrfToken,
  verifyTotpAndElevateSession,
} from "../src/catalog/ownerAuthentication.js";
import { AgentRepository, configureRepositoryAdapter, SessionRepository } from "../src/catalog/repositories.js";
import { createPostgresAdapter, MigrationRunner } from "../src/db/index.js";

test("live PostgreSQL authentication, CSRF, MFA and owner isolation", async (t) => {
  const connectionString = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    if (process.env.CI) assert.fail("POSTGRES_TEST_URL is required in CI");
    t.diagnostic("live PostgreSQL is not configured locally; CI runs this suite against PostgreSQL 15");
    return;
  }

  process.env.MFA_ENCRYPTION_KEY ||= "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const adapter = createPostgresAdapter({ connectionString });
  configureRepositoryAdapter(adapter);
  const unique = Date.now();
  const email = `owner-${unique}@example.test`;
  const password = "Task2-Secure-Password-2026!";

  try {
    const runner = new MigrationRunner(adapter);
    await runner.runMigrations();
    await runner.runMigrations();
    const immutableChecksums = new Map([
      ["001_core.sql", "3fa84fd7f686ab56489cee6bafd99dcda58ceabe67268313412c8c4c0ba979db"],
      ["002_seed_agents.sql", "33011cecbc851388fc6433c110ab9118fd25da276d55ed0b2fd5faec83f26f4d"],
      ["003_agent_digital_identity.sql", "20a8aa319054a29025457a32d7ca6061296c3283c24889357771fcc311d80171"],
      ["004_creative_charter.sql", "2bf1c7292487e05f2e1582eff95b2d517831611ad92b442f3b3186527d58fb1f"],
      ["005_creative_reference.sql", "2846bdd39a03b3421627ea28d148d4df79c06bd0200637bfe200117fe7ceac34"],
      ["006_seed_initial_creative_charters.sql", "9f2b801f2738862ea90eb5734693508189823f7f8343188560ea3cf71b578d65"],
      ["007_owner_agent_communication_studio.sql", "4d164008b597056fa7f70aa800ecdb503ca4dda31073493c8a25de3b533677ed"],
      ["008_owner_authentication_and_sessions.sql", "39d76ebab5ab92133080a054af95f1ade5375c0c6f4c0993f7434d39863eba51"],
    ]);
    const applied = await adapter.query(
      "SELECT filename, checksum FROM schema_migrations WHERE filename <= '008_owner_authentication_and_sessions.sql'"
    );
    assert.equal(applied.rowCount, 8);
    for (const row of applied.rows) assert.equal(row.checksum, immutableChecksums.get(row.filename));
    const owner = await registerOwner(email, password);
    const storedOwner = await adapter.query(
      "SELECT id, email, password_hash FROM owners WHERE id = $1",
      [owner.id]
    );
    assert.equal(storedOwner.rows[0].id, owner.id);
    assert.equal(storedOwner.rows[0].email, email);
    assert.match(storedOwner.rows[0].password_hash, /^\$argon2id\$/);

    const login = await loginOwner(email, password);
    const storedSession = await adapter.query(
      "SELECT token_hash FROM owner_sessions WHERE id = $1",
      [login.session.session.id]
    );
    assert.equal(storedSession.rows[0].token_hash.length, 64);
    assert.equal(storedSession.rows[0].token_hash.includes(login.session.token), false);

    const csrf = await generateCsrfToken(login.session.session.id);
    assert.equal(await verifyCsrfToken(login.session.session.id, csrf), true);
    const storedCsrf = await adapter.query(
      "SELECT token_hash FROM csrf_session_tokens WHERE session_id = $1",
      [login.session.session.id]
    );
    assert.equal(storedCsrf.rows[0].token_hash.length, 64);
    assert.notEqual(storedCsrf.rows[0].token_hash, csrf);

    const enrollment = await enrollTotpMfa(owner.id, login.session.token);
    const confirmCode = generateTotpCode(enrollment.secret, Date.now() - 30_000).code;
    const confirmed = await confirmTotpMfa(owner.id, enrollment.enrollmentId, confirmCode);
    const mfaRow = await adapter.query(
      "SELECT encrypted_totp_secret, last_used_step FROM owner_totp_enrollments WHERE id = $1",
      [enrollment.enrollmentId]
    );
    assert.equal(mfaRow.rows[0].encrypted_totp_secret.includes(enrollment.secret), false);
    assert.ok(mfaRow.rows[0].last_used_step !== null);

    const elevated = await verifyTotpAndElevateSession(
      owner.id,
      login.session.token,
      generateTotpCode(enrollment.secret).code
    );
    assert.equal((await validateAndRetrieveSession(elevated.token)).mfaAssuranceLevel, "high_assurance");
    await assert.rejects(
      () => verifyTotpAndElevateSession(owner.id, elevated.token, generateTotpCode(enrollment.secret).code),
      /REPLAYED_TOTP_CODE_REJECTED/
    );

    assert.equal(await useRecoveryCode(owner.id, confirmed.recoveryCodes[0]), true);
    await assert.rejects(
      () => useRecoveryCode(owner.id, confirmed.recoveryCodes[0]),
      /INVALID_OR_ALREADY_USED_RECOVERY_CODE/
    );

    const otherOwner = "00000000-0000-0000-0000-000000000001";
    const sessions = new SessionRepository();
    assert.equal(await sessions.revoke(elevated.session.id, otherOwner), false);
    assert.equal((await validateAndRetrieveSession(elevated.token)).ownerId, owner.id);

    const agents = new AgentRepository();
    for (let index = 21; index <= 50; index += 1) {
      await agents.add({
        id: `task2-cap-${index}`,
        name: `TASK2_CAP_${index}`,
        namespace: `st.agent.task2-cap-${index}`,
        enabled: true,
      });
    }
    await assert.rejects(
      () => adapter.query(
        "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true)",
        ["task2-cap-51", "TASK2_CAP_51", "st.agent.task2-cap-51"]
      ),
      /AGENT_CAP_REACHED/
    );
  } finally {
    await adapter.query("DELETE FROM agents WHERE id LIKE 'task2-cap-%'").catch(() => {});
    await adapter.closePool();
  }
});
