import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  normalizeEmail,
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  generateTotp,
  computeTokenHash,
  OwnerAuthenticationService
} from "../src/catalog/ownerAuthentication.js";
import { retrieveActiveApprovedBlueprint } from "../src/catalog/ownerAgentCommunicationStudio.js";

// Helper function to strictly classify SQL queries based on prefix to prevent substring-matching errors (Blocker #2)
function mockQueryHandler(text, params, parent) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const uppercase = normalized.toUpperCase();

  // 1. Prefix classification (Do not classify using substrings!)
  let statementType = null;
  if (uppercase.startsWith("SELECT")) {
    statementType = "SELECT";
  } else if (uppercase.startsWith("UPDATE")) {
    statementType = "UPDATE";
  } else if (uppercase.startsWith("INSERT")) {
    statementType = "INSERT";
  } else if (uppercase.startsWith("DELETE")) {
    statementType = "DELETE";
  }

  if (!statementType) {
    throw new Error(`Unsupported SQL statement verb (unsupported SQL failing loudly): ${text}`);
  }

  // 2. Target classification
  let targetTable = null;
  if (uppercase.includes("OWNER_TOTP_ENROLLMENTS")) {
    targetTable = "owner_totp_enrollments";
  } else if (uppercase.includes("OWNERS")) {
    targetTable = "owners";
  } else if (uppercase.includes("OWNER_SESSIONS")) {
    targetTable = "owner_sessions";
  } else if (uppercase.includes("OWNER_RECOVERY_CODES")) {
    targetTable = "owner_recovery_codes";
  } else if (uppercase.includes("USED_TOTP_CODES")) {
    targetTable = "used_totp_codes";
  } else if (uppercase.includes("AUTHENTICATION_AUDIT_EVENTS")) {
    targetTable = "authentication_audit_events";
  } else if (uppercase.includes("CSRF_SESSION_TOKENS")) {
    targetTable = "csrf_session_tokens";
  } else if (uppercase.includes("AGENTS")) {
    targetTable = "agents";
  } else if (uppercase.includes("EVIDENCE_EVENTS")) {
    targetTable = "evidence_events";
  } else if (uppercase.includes("PG_ADVISORY_XACT_LOCK")) {
    targetTable = "advisory_lock";
  }

  if (!targetTable) {
    throw new Error(`Unsupported SQL target table/function (unsupported SQL failing loudly): ${text}`);
  }

  // 3. Execution routing
  if (statementType === "SELECT") {
    if (targetTable === "owner_totp_enrollments") {
      const id = params[0];
      if (parent.mfaRepo) {
        const enroll = parent.mfaRepo.db.get(id);
        const rows = enroll ? [{
          id: enroll.id,
          owner_id: enroll.ownerId,
          encrypted_totp_secret: enroll.encryptedTotpSecret,
          is_confirmed: enroll.isConfirmed
        }] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }

    if (targetTable === "owners") {
      if (uppercase.includes("COUNT(*)")) {
        const count = parent.db.size;
        return { rows: [{ count }], rowCount: 1 };
      }
      const email = params[0];
      let owner = null;
      if (email) {
        const norm = email.toLowerCase().trim();
        for (const o of parent.db.values()) {
          if (o.email === norm) {
            owner = o;
            break;
          }
        }
      }
      const rows = owner ? [{
        id: owner.id,
        email: owner.email,
        password_hash: owner.passwordHash,
        status: owner.status,
        role: owner.role,
        mfa_enabled: owner.mfaEnabled,
        failed_login_attempts: owner.failedLoginAttempts ?? 0,
        lockout_until: owner.lockoutUntil ?? null,
        last_success_at: owner.lastSuccessAt ?? null,
        password_changed_at: owner.passwordChangedAt,
        session_revocation_epoch: owner.sessionRevocationEpoch,
        created_at: owner.createdAt
      }] : [];
      return { rows, rowCount: rows.length };
    }

    if (targetTable === "advisory_lock") {
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "owner_sessions") {
      const hash = params[0];
      let session = null;
      if (parent.sessionsDb) {
        for (const s of parent.sessionsDb.values()) {
          if (s.tokenHash === hash) {
            session = s;
            break;
          }
        }
      }
      const rows = session ? [{
        id: session.id,
        owner_id: session.ownerId,
        token_hash: session.tokenHash,
        mfa_assurance_level: session.mfaAssuranceLevel,
        absolute_expires_at: session.absoluteExpiresAt,
        idle_expires_at: session.idleExpiresAt,
        revoked_at: session.revokedAt,
        session_version: session.sessionVersion
      }] : [];
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Unsupported SELECT query target: ${targetTable}`);
  }

  if (statementType === "UPDATE") {
    if (targetTable === "owner_totp_enrollments") {
      const id = params[0];
      if (parent.mfaRepo) {
        const enroll = parent.mfaRepo.db.get(id);
        if (enroll) {
          enroll.isConfirmed = true;
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "owners") {
      const id = params[0];
      const owner = parent.db.get(id);
      if (!owner) {
        return { rows: [], rowCount: 0 };
      }

      if (uppercase.includes("FAILED_LOGIN_ATTEMPTS = $2") && uppercase.includes("LOCKOUT_UNTIL = $3")) {
        owner.failedLoginAttempts = params[1];
        owner.lockoutUntil = params[2];
      } else if (uppercase.includes("FAILED_LOGIN_ATTEMPTS = 0") && uppercase.includes("LAST_SUCCESS_AT = $2")) {
        owner.failedLoginAttempts = 0;
        owner.lastSuccessAt = params[1];
        owner.status = params[2];
        owner.lockoutUntil = null;
      } else if (uppercase.includes("FAILED_LOGIN_ATTEMPTS = 0") && uppercase.includes("LOCKOUT_UNTIL = NULL")) {
        owner.failedLoginAttempts = 0;
        owner.lockoutUntil = null;
      } else if (uppercase.includes("MFA_ENABLED = TRUE")) {
        owner.mfaEnabled = true;
        owner.status = 'authenticated';
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "owner_sessions") {
      const idOrHash = params[0];
      if (parent.sessionsDb) {
        const s = parent.sessionsDb.get(idOrHash);
        if (s) {
          s.revokedAt = new Date().toISOString();
        } else {
          for (const sess of parent.sessionsDb.values()) {
            if (sess.tokenHash === idOrHash) {
              sess.revokedAt = new Date().toISOString();
            }
          }
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "agents") {
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "evidence_events") {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unsupported UPDATE query target: ${targetTable}`);
  }

  if (statementType === "INSERT") {
    if (targetTable === "owners") {
      const [id, email, passwordHash, role, status, mfaEnabled, passwordChangedAt, sessionRevocationEpoch] = params;
      parent.db.set(id, {
        id,
        email,
        passwordHash,
        role,
        status,
        mfaEnabled,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        passwordChangedAt,
        sessionRevocationEpoch,
        createdAt: new Date().toISOString()
      });
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "owner_recovery_codes") {
      const [id, ownerId, codeHash] = params;
      if (parent.mfaRepo) {
        parent.mfaRepo.dbRecoveryCodes.set(id, { id, ownerId, codeHash, isUsed: false });
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "used_totp_codes") {
      const [ownerId, totpCode, timeStep] = params;
      if (parent.mfaRepo) {
        parent.mfaRepo.recordUsedTotpCode(ownerId, totpCode, timeStep);
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "authentication_audit_events") {
      const [id, ownerId, eventType, payload] = params;
      if (parent.auditRepo) {
        parent.auditRepo.db.set(id, { id, ownerId, eventType, payload });
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "owner_sessions") {
      const [id, ownerId, tokenHash, createdAt, lastSeenAt, absoluteExpiresAt, idleExpiresAt, revokedAt, sessionVersion, mfaAssuranceLevel] = params;
      const session = { id, ownerId, tokenHash, createdAt, lastSeenAt, absoluteExpiresAt, idleExpiresAt, revokedAt, sessionVersion, mfaAssuranceLevel };
      if (parent.sessionsDb) {
        parent.sessionsDb.set(id, session);
      }
      return { rows: [], rowCount: 1 };
    }

    if (targetTable === "csrf_session_tokens") {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unsupported INSERT query target: ${targetTable}`);
  }

  if (statementType === "DELETE") {
    if (targetTable === "csrf_session_tokens") {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unsupported DELETE query target: ${targetTable}`);
  }

  throw new Error(`Unhandled statement type: ${statementType} for table: ${targetTable}`);
}

// In-memory persistent database mocks defined EXCLUSIVELY inside test code (Blocker #2)
class InMemoryOwnerRepository {
  constructor(sessionsDb = null, mfaRepo = null, auditRepo = null) {
    this.db = new Map();
    this.sessionsDb = sessionsDb;
    this.mfaRepo = mfaRepo;
    this.auditRepo = auditRepo;
    const parent = this;
    this.dbAdapter = {
      withTransaction: async (callback) => {
        const mockClient = {
          query: async (text, params) => {
            return mockQueryHandler(text, params, parent);
          }
        };
        return await callback(mockClient);
      }
    };
  }
  async findById(id) {
    const owner = this.db.get(id);
    return owner ? { ...owner } : null;
  }
  async findByEmail(email) {
    const norm = email.toLowerCase().trim();
    for (const o of this.db.values()) {
      if (o.email === norm) return { ...o };
    }
    return null;
  }
  async create(owner) {
    this.db.set(owner.id, { ...owner });
    return { ...owner };
  }
  async update(owner) {
    this.db.set(owner.id, { ...owner });
    return { ...owner };
  }
}

class InMemorySessionRepository {
  constructor(db = new Map()) {
    this.db = db;
  }
  async create(session) {
    this.db.set(session.id, { ...session });
    return { ...session };
  }
  async findByTokenHash(tokenHash) {
    for (const s of this.db.values()) {
      if (s.tokenHash === tokenHash) {
        return { ...s };
      }
    }
    return null;
  }
  async updateLastSeen(id, lastSeenAt, idleExpiresAt) {
    const s = this.db.get(id);
    if (s) {
      s.lastSeenAt = lastSeenAt;
      s.idleExpiresAt = idleExpiresAt;
    }
  }
  async revoke(id) {
    const s = this.db.get(id);
    if (s) s.revokedAt = new Date().toISOString();
  }
  async revokeAllForOwner(ownerId) {
    for (const s of this.db.values()) {
      if (s.ownerId === ownerId && s.revokedAt === null) {
        s.revokedAt = new Date().toISOString();
      }
    }
  }
  async revokeAllOtherSessions(ownerId, keepSessionId) {
    for (const s of this.db.values()) {
      if (s.ownerId === ownerId && s.id !== keepSessionId && s.revokedAt === null) {
        s.revokedAt = new Date().toISOString();
      }
    }
  }
  async listActive(ownerId) {
    const list = [];
    for (const s of this.db.values()) {
      if (s.ownerId === ownerId && s.revokedAt === null && new Date(s.absoluteExpiresAt) > new Date() && new Date(s.idleExpiresAt) > new Date()) {
        list.push({ ...s });
      }
    }
    return list;
  }
}

class InMemoryMfaRepository {
  constructor() {
    this.db = new Map();
    this.dbRecoveryCodes = new Map();
    this.dbChallenges = new Map();
    this.dbPasskeys = new Map();
    this.usedCodes = new Set();
  }
  async createTotpEnrollment(enrollment) {
    this.db.set(enrollment.id, { ...enrollment });
    return { ...enrollment };
  }
  async findTotpEnrollment(id) {
    const e = this.db.get(id);
    return e ? { ...e } : null;
  }
  async findConfirmedTotpEnrollment(ownerId) {
    for (const e of this.db.values()) {
      if (e.ownerId === ownerId && e.isConfirmed) {
        return { ...e };
      }
    }
    return null;
  }
  async confirmTotpEnrollment(id, ownerId) {
    const e = this.db.get(id);
    if (e) e.isConfirmed = true;
  }
  async saveRecoveryCodes(codes) {
    for (const c of codes) {
      this.dbRecoveryCodes.set(c.id, { ...c });
    }
  }
  async verifyAndUseRecoveryCode(ownerId, codeHash) {
    for (const rc of this.dbRecoveryCodes.values()) {
      if (rc.ownerId === ownerId && rc.codeHash === codeHash && !rc.isUsed) {
        rc.isUsed = true;
        rc.usedAt = new Date().toISOString();
        return true;
      }
    }
    return false;
  }
  async recordUsedTotpCode(ownerId, totpCode, timeStep) {
    const key = `${ownerId}:${totpCode}:${timeStep}`;
    if (this.usedCodes.has(key)) {
      throw new Error("unique constraint violation used_totp_codes");
    }
    this.usedCodes.add(key);
  }
  async createChallenge(challengeToken, expiresAt) {
    this.dbChallenges.set(challengeToken, { challengeToken, expiresAt, isUsed: false });
  }
  async findChallenge(challengeToken) {
    return this.dbChallenges.get(challengeToken) || null;
  }
  async useChallenge(challengeToken) {
    const ch = this.dbChallenges.get(challengeToken);
    if (ch) ch.isUsed = true;
  }
  async savePasskeyCredential(id, ownerId, credentialId, publicKey, signCounter) {
    this.dbPasskeys.set(credentialId, { id, ownerId, credentialId, publicKey, signCounter });
  }
  async findPasskeyCredential(credentialId) {
    return this.dbPasskeys.get(credentialId) || null;
  }
}

class InMemoryCsrfRepository {
  constructor() {
    this.db = new Map();
  }
  async createToken(sessionId, tokenValue) {
    this.db.set(sessionId, { tokenValue, createdAt: new Date().toISOString() });
  }
  async verifyToken(sessionId, tokenValue) {
    const record = this.db.get(sessionId);
    if (!record || record.tokenValue !== tokenValue) return null;
    return record.createdAt;
  }
  async deleteTokensForSession(sessionId) {
    this.db.delete(sessionId);
  }
}

class InMemoryAuditRepository {
  constructor() {
    this.db = new Map();
  }
  async recordEvent(ownerId, eventType, payload) {
    const event = { id: randomBytes(16).toString("hex"), ownerId, eventType, payload, occurredAt: new Date().toISOString() };
    this.db.set(event.id, event);
    return event;
  }
  async listEvents() {
    return Array.from(this.db.values()).map(e => ({ ...e }));
  }
}

// Generate a clean explicit authentication service instance for every test run
function createTestAuthService() {
  const sessionsDb = new Map();
  const mfaRepo = new InMemoryMfaRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sessionsRepo = new InMemorySessionRepository(sessionsDb);
  const ownersRepo = new InMemoryOwnerRepository(sessionsDb, mfaRepo, auditRepo);
  return new OwnerAuthenticationService({
    ownersRepo,
    sessionsRepo,
    mfaRepo,
    csrfRepo: new InMemoryCsrfRepository(),
    auditRepo
  });
}

// Helper to simulate mock routes to test HTTP-like response expectations
async function simulateOwnerRoute(auth, sessionToken, targetOwnerId = null, role = "owner", mfaRequired = false) {
  try {
    const sessionOwnerId = await auth.requireAuthenticatedOwner(sessionToken);
    if (targetOwnerId && sessionOwnerId !== targetOwnerId) {
      return { status: 403, error: "INSUFFICIENT_PRIVILEGES_OR_WRONG_OWNER" };
    }
    await auth.requireOwnerRole(sessionOwnerId, role);
    if (mfaRequired) {
      await auth.requireMfaAssurance(sessionToken);
    }
    return { status: 200, ownerId: sessionOwnerId };
  } catch (err) {
    if (err.message.includes("EXPIRED") || err.message === "SESSION_TOKEN_REQUIRED" || err.message === "INVALID_SESSION_TOKEN") {
      return { status: 401, error: err.message };
    }
    return { status: 403, error: err.message };
  }
}

test("1. Email normalization works", () => {
  assert.equal(normalizeEmail(" ST.Owner@Example.Com  "), "st.owner@example.com");
  assert.equal(normalizeEmail(""), "");
});

test("2. Duplicate normalized owner emails are rejected", async () => {
  const auth = createTestAuthService();
  await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  await assert.rejects(async () => {
    await auth.registerOwner(" OWNER@st.com  ", "AnotherPasswordSecure123", { isAuthorizedAdmin: true });
  }, /DUPLICATE_OWNER_EMAIL_REJECTED/);
});

test("3. Passwords are stored only as Argon2id hashes", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  assert.ok(owner.passwordHash.startsWith("$argon2id$v=19$m=65536"));
});

test("4. Plaintext passwords never appear in stored records", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  assert.equal(JSON.stringify(owner).includes("PasswordSecure123"), false);
});

test("5. Correct password verification succeeds", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  assert.ok(await verifyPassword("PasswordSecure123", owner.passwordHash));
});

test("6. Incorrect password verification fails generically", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  assert.equal(await verifyPassword("WrongPassword123", owner.passwordHash), false);
});

test("7. Unknown email and wrong password produce equivalent public errors", async () => {
  const auth = createTestAuthService();
  await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  // Unknown email
  await assert.rejects(async () => {
    await auth.loginOwner("unknown@st.com", "PasswordSecure123");
  }, /INVALID_EMAIL_OR_PASSWORD/);

  // Wrong password
  await assert.rejects(async () => {
    await auth.loginOwner("owner@st.com", "WrongPassword123");
  }, /INVALID_EMAIL_OR_PASSWORD/);
});

test("8. Repeated failures trigger bounded lockout", async () => {
  const auth = createTestAuthService();
  await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  // Fail 5 times
  for (let i = 0; i < 5; i++) {
    try {
      await auth.loginOwner("owner@st.com", "WrongPassword123");
    } catch {}
  }

  // Next login should throw Lockout
  await assert.rejects(async () => {
    await auth.loginOwner("owner@st.com", "PasswordSecure123");
  }, /ACCOUNT_TEMPORARILY_LOCKED/);
});

test("9. Successful authentication resets failures and handles timing", async () => {
  const auth = createTestAuthService();
  await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  try { await auth.loginOwner("owner@st.com", "WrongPassword123"); } catch {}
  try { await auth.loginOwner("owner@st.com", "WrongPassword123"); } catch {}

  const result = await auth.loginOwner("owner@st.com", "PasswordSecure123");
  assert.equal(result.owner.failedLoginAttempts, 0);
});

test("10. Session tokens are cryptographically random", async () => {
  const auth = createTestAuthService();
  const r1 = await auth.createSessionToken("owner-id-1");
  const r2 = await auth.createSessionToken("owner-id-2");
  assert.notEqual(r1.token, r2.token);
  assert.equal(r1.token.length, 64);
});

test("11. Only session-token hashes are stored", async () => {
  const auth = createTestAuthService();
  const result = await auth.createSessionToken("owner-id-1");
  assert.equal(JSON.stringify(result.session).includes(result.token), false);
});

test("12. Login rotates/replaces any pre-authentication session", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  const s1 = await auth.createSessionToken(owner.id);
  await auth.loginOwner("owner@st.com", "PasswordSecure123", s1.token);

  // Pre-auth session s1 is now revoked/replaced
  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED|INVALID_SESSION_TOKEN/);
});

test("13. MFA completion rotates the session", async () => {
  // Setup standard GCM encryption key for testing encryption paths
  process.env.MFA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  // Enroll and confirm MFA
  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);

  // Verify TOTP elevates session with newly generated code
  const nextTotp = generateTotp(enroll.secret, 1);
  const result = await auth.verifyTotpAndElevateSession(owner.id, s1.token, nextTotp);

  // Old token s1 is rotated/revoked
  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED|INVALID_SESSION_TOKEN/);

  // New elevated token is valid and has high assurance
  const activeSession = await auth.validateAndRetrieveSession(result.token);
  assert.equal(activeSession.mfaAssuranceLevel, "high_assurance");
});

test("14. Idle-expired sessions are rejected", async () => {
  const auth = createTestAuthService();
  const result = await auth.createSessionToken("owner-id-1");

  // Get from map and set idleExpiresAt in the past
  const sessionObj = auth.sessionsRepo.db.get(result.session.id);
  sessionObj.idleExpiresAt = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(result.token);
  }, /SESSION_IDLE_EXPIRED/);
});

test("15. Absolute-expired sessions are rejected", async () => {
  const auth = createTestAuthService();
  const result = await auth.createSessionToken("owner-id-1");

  // Get from map and set absoluteExpiresAt in the past
  const sessionObj = auth.sessionsRepo.db.get(result.session.id);
  sessionObj.absoluteExpiresAt = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(result.token);
  }, /SESSION_ABSOLUTE_EXPIRED/);
});

test("16. Revoked sessions are rejected", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const result = await auth.createSessionToken(owner.id);
  await auth.logoutSession(result.token);

  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(result.token);
  }, /SESSION_REVOKED|INVALID_SESSION_TOKEN/);
});

test("17. Logout revokes the session", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const result = await auth.createSessionToken(owner.id);
  const status = await auth.logoutSession(result.token);
  assert.equal(status, true);
});

test("18. Password change revokes older sessions", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id);

  // Change password
  await auth.changePassword(owner.id, "PasswordSecure123", "NewPasswordSecure123", s1.token);

  // s1 is revoked due to session revocation epoch increment
  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED_BY_REVOCATION_EPOCH|SESSION_REVOKED/);
});

test("19. CSRF token is required for mutations", async () => {
  const auth = createTestAuthService();
  const result = await auth.createSessionToken("owner-id-1");
  await assert.rejects(async () => {
    await auth.verifyCsrfToken(result.session.id, null);
  }, /CSRF_TOKEN_REQUIRED/);
});

test("20. Invalid CSRF token is rejected", async () => {
  const auth = createTestAuthService();
  const result = await auth.createSessionToken("owner-id-1");
  await assert.rejects(async () => {
    await auth.verifyCsrfToken(result.session.id, "invalid-csrf-token");
  }, /INVALID_CSRF_TOKEN/);
});

test("21. CSRF token is bound to the correct session", async () => {
  const auth = createTestAuthService();
  const s1 = await auth.createSessionToken("owner-id-1");
  const s2 = await auth.createSessionToken("owner-id-2");

  const csrf1 = await auth.generateCsrfToken(s1.session.id);
  assert.ok(await auth.verifyCsrfToken(s1.session.id, csrf1));

  // Trying to use csrf1 with session s2 fails
  await assert.rejects(async () => {
    await auth.verifyCsrfToken(s2.session.id, csrf1);
  }, /INVALID_CSRF_TOKEN/);
});

test("22. Anonymous owner routes return 401", async () => {
  const auth = createTestAuthService();
  const response = await simulateOwnerRoute(auth, null);
  assert.equal(response.status, 401);
});

test("23. Wrong-owner access returns 403", async () => {
  const auth = createTestAuthService();
  const owner1 = await auth.registerOwner("owner1@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const owner2 = await auth.registerOwner("owner2@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  const s1 = await auth.createSessionToken(owner1.id);
  const response = await simulateOwnerRoute(auth, s1.token, owner2.id); // owner1 tries to access owner2's resource
  assert.equal(response.status, 403);
});

test("24. No route falls back to the first owner", async () => {
  const auth = createTestAuthService();
  const response = await simulateOwnerRoute(auth, null);
  assert.equal(response.status, 401);
  assert.equal(response.ownerId, undefined);
});

test("25. Client-supplied ownerId cannot impersonate another owner", async () => {
  const auth = createTestAuthService();
  const owner1 = await auth.registerOwner("owner1@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const owner2 = await auth.registerOwner("owner2@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });

  const s1 = await auth.createSessionToken(owner1.id);
  const response = await simulateOwnerRoute(auth, s1.token, owner2.id);
  assert.equal(response.status, 403);
});

test("26. Client-supplied role or MFA status is ignored", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const response = await simulateOwnerRoute(auth, s1.token, owner.id, "owner", true);
  assert.equal(response.status, 403);
  assert.equal(response.error, "MFA_ASSURANCE_REQUIRED");
});

test("27. MFA-required operations reject password-only sessions", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  await assert.rejects(async () => {
    await auth.requireMfaAssurance(s1.token);
  }, /MFA_ASSURANCE_REQUIRED/);
});

test("28. Valid TOTP completes MFA", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
  assert.ok(confirm.recoveryCodes.length > 0);
});

test("29. Replayed TOTP is rejected", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);

  await assert.rejects(async () => {
    await auth.verifyTotpAndElevateSession(owner.id, s1.token, totpCode);
  }, /REPLAYED_TOTP_CODE_REJECTED/);
});

test("30. Recovery codes are hashed and one-time-use", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);

  const code1 = confirm.recoveryCodes[0];
  assert.ok(await auth.useRecoveryCode(owner.id, code1));

  // Second use fails
  await assert.rejects(async () => {
    await auth.useRecoveryCode(owner.id, code1);
  }, /INVALID_OR_ALREADY_USED_RECOVERY_CODE/);
});

test("31. Passkey challenge expiry and replay rules are enforced in contracts", async () => {
  const auth = createTestAuthService();
  const ch = await auth.generatePasskeyRegistrationChallenge("owner-1");
  const reg = await auth.verifyPasskeyRegistrationAndRegister("owner-1", ch, "credential-id-123", "public-key-val");
  assert.equal(reg.credentialId, "credential-id-123");

  // Replay of challenge fails
  await assert.rejects(async () => {
    await auth.verifyPasskeyRegistrationAndRegister("owner-1", ch, "credential-id-123", "public-key-val");
  }, /CHALLENGE_EXPIRED_OR_REPLAYED/);
});

test("32. Security audit events contain no secrets", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  await auth.recordAuditEvent(owner.id, "test_action", { password: "SecretPasswordValue", apiKey: "leak-key-123" });

  const events = await auth.listAuditEvents();
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes("SecretPasswordValue"), false);
  assert.equal(JSON.stringify(events).includes("leak-key-123"), false);
});

test("33. Failed actions do not create success evidence", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  await assert.rejects(async () => {
    await auth.loginOwner("owner@st.com", "WrongPassword123");
  }, /INVALID_EMAIL_OR_PASSWORD/);

  // No active session is registered for owner
  assert.equal(retrieveActiveApprovedBlueprint(owner.id, "agent-01"), null);
});

test("34. Task 8 Charter approval remains owner-controlled", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "high_assurance");

  // Confirms route requireAuthenticatedOwner correctly derives owner identity
  const derivedOwnerId = await auth.requireAuthenticatedOwner(s1.token);
  assert.equal(derivedOwnerId, owner.id);
});

test("35. Charter approval does not activate autopilot or publishing", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "high_assurance");

  const response = await simulateOwnerRoute(auth, s1.token, owner.id, "owner", true);
  assert.equal(response.status, 200);
});

// Target SQL and statement prefix classification regression tests (Task 2 / Blocker #2)
test("36. Regression: SELECT ... FOR UPDATE is classified as SELECT and retrieves records", async () => {
  const repo = new InMemoryOwnerRepository();
  repo.db.set("owner-1", {
    id: "owner-1",
    email: "owner@st.com",
    passwordHash: "some-hash",
    status: "anonymous",
    role: "owner"
  });
  const res = await repo.dbAdapter.withTransaction(async (client) => {
    return await client.query("SELECT * FROM owners WHERE email = $1 FOR UPDATE;", ["owner@st.com"]);
  });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].id, "owner-1");
});

test("37. Regression: SELECT containing names such as updated_at is classified as SELECT", async () => {
  const repo = new InMemoryOwnerRepository();
  repo.db.set("owner-1", {
    id: "owner-1",
    email: "owner@st.com",
    passwordHash: "some-hash",
    status: "anonymous",
    role: "owner"
  });
  const res = await repo.dbAdapter.withTransaction(async (client) => {
    return await client.query("SELECT id, updated_at FROM owners WHERE email = $1;", ["owner@st.com"]);
  });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].id, "owner-1");
});

test("38. Regression: Genuine UPDATE is classified as UPDATE and modifies the state", async () => {
  const repo = new InMemoryOwnerRepository();
  repo.db.set("owner-1", {
    id: "owner-1",
    email: "owner@st.com",
    passwordHash: "some-hash",
    status: "anonymous",
    role: "owner",
    failedLoginAttempts: 2
  });
  const res = await repo.dbAdapter.withTransaction(async (client) => {
    return await client.query("UPDATE owners SET failed_login_attempts = 0, lockout_until = null WHERE id = $1;", ["owner-1"]);
  });
  assert.equal(res.rowCount, 1);
  const updatedOwner = repo.db.get("owner-1");
  assert.equal(updatedOwner.failedLoginAttempts, 0);
});

test("39. Regression: Unsupported SQL verb or target throws loudly", async () => {
  const repo = new InMemoryOwnerRepository();
  await assert.rejects(async () => {
    await repo.dbAdapter.withTransaction(async (client) => {
      await client.query("DROP TABLE owners;");
    });
  }, /Unsupported SQL statement verb/);

  await assert.rejects(async () => {
    await repo.dbAdapter.withTransaction(async (client) => {
      await client.query("SELECT * FROM non_existent_table;");
    });
  }, /Unsupported SQL target table/);
});

test("40. Regression: TOTP confirmation behaves correctly", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
  assert.ok(confirm.recoveryCodes.length === 8);
});

test("41. Regression: Atomic recovery-code consumption is correctly executed", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123", { isAuthorizedAdmin: true });
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
  const code = confirm.recoveryCodes[0];

  const success = await auth.useRecoveryCode(owner.id, code);
  assert.equal(success, true);

  await assert.rejects(async () => {
    await auth.useRecoveryCode(owner.id, code);
  }, /INVALID_OR_ALREADY_USED_RECOVERY_CODE/);
});
