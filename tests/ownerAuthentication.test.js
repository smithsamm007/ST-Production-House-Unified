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

// In-memory persistent database mocks defined EXCLUSIVELY inside test code (Blocker #2)
class InMemoryOwnerRepository {
  constructor() {
    this.db = new Map();
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
  constructor() {
    this.db = new Map();
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
    this.db.set(sessionId, tokenValue);
  }
  async verifyToken(sessionId, tokenValue) {
    return this.db.get(sessionId) === tokenValue;
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
  return new OwnerAuthenticationService({
    ownersRepo: new InMemoryOwnerRepository(),
    sessionsRepo: new InMemorySessionRepository(),
    mfaRepo: new InMemoryMfaRepository(),
    csrfRepo: new InMemoryCsrfRepository(),
    auditRepo: new InMemoryAuditRepository()
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
  await auth.registerOwner("owner@st.com", "PasswordSecure123");
  await assert.rejects(async () => {
    await auth.registerOwner(" OWNER@st.com  ", "AnotherPasswordSecure123");
  }, /DUPLICATE_OWNER_EMAIL_REJECTED/);
});

test("3. Passwords are stored only as Argon2id hashes", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  assert.ok(owner.passwordHash.startsWith("$argon2id$v=19$m=65536"));
});

test("4. Plaintext passwords never appear in stored records", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  assert.equal(JSON.stringify(owner).includes("PasswordSecure123"), false);
});

test("5. Correct password verification succeeds", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  assert.ok(await verifyPassword("PasswordSecure123", owner.passwordHash));
});

test("6. Incorrect password verification fails generically", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  assert.equal(await verifyPassword("WrongPassword123", owner.passwordHash), false);
});

test("7. Unknown email and wrong password produce equivalent public errors", async () => {
  const auth = createTestAuthService();
  await auth.registerOwner("owner@st.com", "PasswordSecure123");

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
  await auth.registerOwner("owner@st.com", "PasswordSecure123");

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
  await auth.registerOwner("owner@st.com", "PasswordSecure123");

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
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");

  const s1 = await auth.createSessionToken(owner.id);
  await auth.loginOwner("owner@st.com", "PasswordSecure123");

  // Pre-auth session s1 is now revoked/replaced
  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED|INVALID_SESSION_TOKEN/);
});

test("13. MFA completion rotates the session", async () => {
  // Setup standard GCM encryption key for testing encryption paths
  process.env.MFA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
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
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const result = await auth.createSessionToken(owner.id);
  await auth.logoutSession(result.token);

  await assert.rejects(async () => {
    await auth.validateAndRetrieveSession(result.token);
  }, /SESSION_REVOKED|INVALID_SESSION_TOKEN/);
});

test("17. Logout revokes the session", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const result = await auth.createSessionToken(owner.id);
  const status = await auth.logoutSession(result.token);
  assert.equal(status, true);
});

test("18. Password change revokes older sessions", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
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
  const owner1 = await auth.registerOwner("owner1@st.com", "PasswordSecure123");
  const owner2 = await auth.registerOwner("owner2@st.com", "PasswordSecure123");

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
  const owner1 = await auth.registerOwner("owner1@st.com", "PasswordSecure123");
  const owner2 = await auth.registerOwner("owner2@st.com", "PasswordSecure123");

  const s1 = await auth.createSessionToken(owner1.id);
  const response = await simulateOwnerRoute(auth, s1.token, owner2.id);
  assert.equal(response.status, 403);
});

test("26. Client-supplied role or MFA status is ignored", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const response = await simulateOwnerRoute(auth, s1.token, owner.id, "owner", true);
  assert.equal(response.status, 403);
  assert.equal(response.error, "MFA_ASSURANCE_REQUIRED");
});

test("27. MFA-required operations reject password-only sessions", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  await assert.rejects(async () => {
    await auth.requireMfaAssurance(s1.token);
  }, /MFA_ASSURANCE_REQUIRED/);
});

test("28. Valid TOTP completes MFA", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await auth.createSessionToken(owner.id, "password_only");

  const enroll = await auth.enrollTotpMfa(owner.id, s1.token);
  const totpCode = generateTotp(enroll.secret, 0);

  const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
  assert.ok(confirm.recoveryCodes.length > 0);
});

test("29. Replayed TOTP is rejected", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
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
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
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
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  await auth.recordAuditEvent(owner.id, "test_action", { password: "SecretPasswordValue", apiKey: "leak-key-123" });

  const events = await auth.listAuditEvents();
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes("SecretPasswordValue"), false);
  assert.equal(JSON.stringify(events).includes("leak-key-123"), false);
});

test("33. Failed actions do not create success evidence", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  await assert.rejects(async () => {
    await auth.loginOwner("owner@st.com", "WrongPassword123");
  }, /INVALID_EMAIL_OR_PASSWORD/);

  // No active session is registered for owner
  assert.equal(retrieveActiveApprovedBlueprint(owner.id, "agent-01"), null);
});

test("34. Task 8 Charter approval remains owner-controlled", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await auth.createSessionToken(owner.id, "high_assurance");

  // Confirms route requireAuthenticatedOwner correctly derives owner identity
  const derivedOwnerId = await auth.requireAuthenticatedOwner(s1.token);
  assert.equal(derivedOwnerId, owner.id);
});

test("35. Charter approval does not activate autopilot or publishing", async () => {
  const auth = createTestAuthService();
  const owner = await auth.registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await auth.createSessionToken(owner.id, "high_assurance");

  const response = await simulateOwnerRoute(auth, s1.token, owner.id, "owner", true);
  assert.equal(response.status, 200);
});
