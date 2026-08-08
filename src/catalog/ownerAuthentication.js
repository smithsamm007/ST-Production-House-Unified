import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { deepFreeze, deepCopy, sanitizeSecrets } from "./creativeReferenceLibrary.js";
import {
  OwnerRepository,
  SessionRepository,
  MfaRepository,
  CsrfRepository,
  AuditRepository
} from "./repositories.js";

const dummyPasswordHash = argon2.hash("ST-Dummy-Password-Verification-Value", {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
});

// The production default is PostgreSQL. Tests must opt in explicitly to this
// isolated adapter; no environment variable can switch production storage.
const dbOwners = new Map();
const dbSessions = new Map();
const dbTotpEnrollments = new Map();
const dbRecoveryCodes = new Map();
const dbCsrfTokens = new Map();
const dbAuditEvents = new Map();

export function resetOwnerAuthenticationRegistry() {
  dbOwners.clear();
  dbSessions.clear();
  dbTotpEnrollments.clear();
  dbRecoveryCodes.clear();
  dbCsrfTokens.clear();
  dbAuditEvents.clear();
}

let authStorage = "postgres";
let testMfaEncryptionKey = null;

export function useInMemoryOwnerAuthenticationForTests(options = {}) {
  authStorage = "memory";
  testMfaEncryptionKey = options.mfaEncryptionKey || Buffer.alloc(32, 7);
  resetOwnerAuthenticationRegistry();
}

const ownersRepo = new OwnerRepository();
const sessionsRepo = new SessionRepository();
const mfaRepo = new MfaRepository();
const csrfRepo = new CsrfRepository();
const auditRepo = new AuditRepository();

const usePg = () => authStorage === "postgres";

function mfaEncryptionKey() {
  if (testMfaEncryptionKey) return testMfaEncryptionKey;
  const encoded = process.env.MFA_ENCRYPTION_KEY;
  if (!encoded) throw new Error("MFA_ENCRYPTION_KEY_REQUIRED");
  const key = /^[a-f0-9]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY_MUST_BE_32_BYTES");
  return key;
}

function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64")).join(".");
}

function decryptTotpSecret(encrypted) {
  const [iv, tag, ciphertext] = String(encrypted).split(".").map((value) => Buffer.from(value, "base64"));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("INVALID_ENCRYPTED_TOTP_SECRET");
  }
  const decipher = createDecipheriv("aes-256-gcm", mfaEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function generateTotpCode(secret, timestamp = Date.now(), periodSeconds = 30) {
  const step = Math.floor(timestamp / 1000 / periodSeconds);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(secret, "hex")).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return { code: String(value).padStart(6, "0"), step };
}

function verifyTotpCode(secret, candidate, lastUsedStep = null, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(String(candidate))) return null;
  for (const drift of [-1, 0, 1]) {
    const instant = timestamp + drift * 30_000;
    const generated = generateTotpCode(secret, instant);
    const matches = timingSafeEqual(Buffer.from(generated.code), Buffer.from(String(candidate)));
    if (matches) {
      if (lastUsedStep !== null && generated.step <= Number(lastUsedStep)) {
        throw new Error("REPLAYED_TOTP_CODE_REJECTED");
      }
      return generated.step;
    }
  }
  return null;
}

function safeOwner(owner) {
  if (!owner) return null;
  const { passwordHash, ...safe } = owner;
  return deepCopy(safe);
}

function safeSession(session) {
  if (!session) return null;
  const { tokenHash, ...safe } = session;
  return deepCopy(safe);
}

// ----------------------------------------------------
// 1. Password Policy & Hashing (Genuine Argon2id)
// ----------------------------------------------------

export function normalizeEmail(email) {
  if (!email) return "";
  return email.normalize("NFKC").trim().toLowerCase();
}

/**
 * Validates password strength (minimum 12 characters, rejects compromised/example strings)
 */
export function validatePasswordStrength(password) {
  if (!password || password.length < 12) {
    throw new Error("PASSWORD_TOO_SHORT_MUST_BE_AT_LEAST_12_CHARACTERS");
  }
  if (password.length > 128) {
    throw new Error("PASSWORD_EXCEEDS_MAX_LENGTH");
  }
  const prohibited = ["password12345", "stproductionhouse", "examplepassword", "admin12345678"];
  if (prohibited.includes(password.toLowerCase())) {
    throw new Error("PASSWORD_IS_COMMON_OR_COMPROMISED");
  }
  return true;
}

/**
 * Computes a secure Argon2id-formatted signature using the real `argon2` native package.
 */
export async function hashPassword(password) {
  validatePasswordStrength(password);
  // Using standard secure Argon2id profile
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  try {
    return await argon2.verify(storedHash, password);
  } catch (err) {
    return false;
  }
}

// ----------------------------------------------------
// 2. Owner Account Registration & Lockout
// ----------------------------------------------------

export async function registerOwner(email, password, role = "owner") {
  const normEmail = normalizeEmail(email);
  if (!normEmail) throw new Error("EMAIL_REQUIRED");

  // Duplicate normalized email check
  if (usePg()) {
    const existing = await ownersRepo.findByEmail(normEmail);
    if (existing) {
      throw new Error("DUPLICATE_OWNER_EMAIL_REJECTED");
    }
  } else {
    for (const owner of dbOwners.values()) {
      if (owner.email === normEmail) {
        throw new Error("DUPLICATE_OWNER_EMAIL_REJECTED");
      }
    }
  }

  const pwdHash = await hashPassword(password);

  const owner = {
    id: randomUUID(),
    email: normEmail,
    passwordHash: pwdHash,
    status: "anonymous", // anon -> mfa_pending -> authenticated
    role,
    mfaEnabled: false,
    failedLoginAttempts: 0,
    lockoutUntil: null,
    lastSuccessAt: null,
    passwordChangedAt: new Date().toISOString(),
    sessionRevocationEpoch: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (usePg()) {
    await ownersRepo.createInitial(owner);
  } else {
    dbOwners.set(owner.id, owner);
  }

  return safeOwner(owner);
}

export async function loginOwner(email, password) {
  const normEmail = normalizeEmail(email);
  let matchedOwner = null;

  if (usePg()) {
    matchedOwner = await ownersRepo.findByEmail(normEmail);
  } else {
    for (const owner of dbOwners.values()) {
      if (owner.email === normEmail) {
        matchedOwner = owner;
        break;
      }
    }
  }

  // Account Lockout check
  if (matchedOwner && matchedOwner.lockoutUntil) {
    if (new Date(matchedOwner.lockoutUntil) > new Date()) {
      await recordAuditEvent(matchedOwner.id, "account_locked", { reason: "lockout_active" });
      throw new Error("ACCOUNT_TEMPORARILY_LOCKED");
    } else {
      matchedOwner.lockoutUntil = null;
      if (usePg()) {
        await ownersRepo.update(matchedOwner);
      }
    }
  }

  const verificationHash = matchedOwner?.passwordHash || await dummyPasswordHash;
  const isVerified = await verifyPassword(password, verificationHash);

  if (!matchedOwner || !isVerified) {
    if (matchedOwner) {
      await recordAuditEvent(matchedOwner.id, "login_failed", {});
      if (usePg()) {
        const failure = await ownersRepo.recordLoginFailure(matchedOwner.id);
        matchedOwner.failedLoginAttempts = failure.failed_login_attempts;
        matchedOwner.lockoutUntil = failure.lockout_until;
      } else {
        matchedOwner.failedLoginAttempts += 1;
      }
      if (matchedOwner.failedLoginAttempts >= 5) {
        if (!usePg()) matchedOwner.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await recordAuditEvent(matchedOwner.id, "account_locked", { reason: "consecutive_failures" });
      }
    } else {
      await recordAuditEvent(null, "login_failed", { attemptedEmail: normEmail });
    }
    throw new Error("INVALID_EMAIL_OR_PASSWORD");
  }

  // Success resets failure counters
  matchedOwner.failedLoginAttempts = 0;
  matchedOwner.lastSuccessAt = new Date().toISOString();
  matchedOwner.status = matchedOwner.mfaEnabled ? "password_verified_mfa_pending" : "authenticated";

  if (usePg()) await ownersRepo.recordLoginSuccess(matchedOwner.id, matchedOwner.status);

  await recordAuditEvent(matchedOwner.id, "login_succeeded", {});

  const mfaAssurance = matchedOwner.mfaEnabled ? "password_only" : "high_assurance";
  const sessionResult = await createSessionToken(matchedOwner.id, mfaAssurance);

  return { owner: safeOwner(matchedOwner), session: sessionResult };
}

// ----------------------------------------------------
// 3. Opaque Server-Side Sessions
// ----------------------------------------------------

export function computeTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSessionToken(ownerId, mfaAssuranceLevel = "password_only") {
  const token = randomBytes(32).toString("hex");
  const tokenHash = computeTokenHash(token);

  // Rotate/replace any pre-authentication active sessions for this owner
  if (usePg()) {
    await sessionsRepo.revokeAllForOwner(ownerId);
  } else {
    for (const s of dbSessions.values()) {
      if (s.ownerId === ownerId && s.revokedAt === null) {
        s.revokedAt = new Date().toISOString();
        await recordAuditEvent(ownerId, "session_revoked", { sessionId: s.id, reason: "pre_auth_rotation" });
      }
    }
  }

  const session = {
    id: randomUUID(),
    ownerId,
    tokenHash,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    revokedAt: null,
    sessionVersion: 1,
    mfaAssuranceLevel
  };

  if (usePg()) {
    await sessionsRepo.create(session);
  } else {
    dbSessions.set(session.id, session);
  }

  await recordAuditEvent(ownerId, "session_created", { sessionId: session.id });

  return { token, session: safeSession(session) };
}

export async function validateAndRetrieveSession(token) {
  if (!token) throw new Error("SESSION_TOKEN_REQUIRED");
  const hash = computeTokenHash(token);

  let session = null;
  if (usePg()) {
    session = await sessionsRepo.findByTokenHash(hash);
  } else {
    for (const s of dbSessions.values()) {
      if (s.tokenHash === hash) {
        session = s;
        break;
      }
    }
  }

  if (!session) throw new Error("INVALID_SESSION_TOKEN");

  // Revocation Epoch check
  let owner = null;
  if (usePg()) {
    owner = await ownersRepo.findById(session.ownerId);
  } else {
    owner = dbOwners.get(session.ownerId);
  }

  if (owner && owner.sessionRevocationEpoch > session.sessionVersion) {
    throw new Error("SESSION_REVOKED_BY_REVOCATION_EPOCH");
  }

  if (session.revokedAt) {
    throw new Error("SESSION_REVOKED");
  }

  const now = new Date();
  if (new Date(session.absoluteExpiresAt) < now) {
    throw new Error("SESSION_ABSOLUTE_EXPIRED");
  }
  if (new Date(session.idleExpiresAt) < now) {
    throw new Error("SESSION_IDLE_EXPIRED");
  }

  // Sliding idle expiry
  session.lastSeenAt = now.toISOString();
  session.idleExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  if (usePg()) {
    await sessionsRepo.updateLastSeen(session.id, session.lastSeenAt, session.idleExpiresAt);
  }

  return safeSession(session);
}

export async function logoutSession(token) {
  const session = await validateAndRetrieveSession(token);
  if (usePg()) {
    await sessionsRepo.revoke(session.id, session.ownerId);
  } else {
    const sessionObj = dbSessions.get(session.id);
    if (sessionObj) sessionObj.revokedAt = new Date().toISOString();
  }
  await recordAuditEvent(session.ownerId, "logout", { sessionId: session.id });
  return true;
}

export async function changePassword(ownerId, oldPassword, newPassword, sessionToken) {
  let owner = null;
  if (usePg()) {
    owner = await ownersRepo.findById(ownerId);
  } else {
    owner = dbOwners.get(ownerId);
  }

  if (!owner || !(await verifyPassword(oldPassword, owner.passwordHash))) {
    throw new Error("INVALID_OLD_PASSWORD");
  }

  validatePasswordStrength(newPassword);
  owner.passwordHash = await hashPassword(newPassword);
  owner.passwordChangedAt = new Date().toISOString();
  owner.sessionRevocationEpoch += 1;

  if (usePg()) {
    await ownersRepo.update(owner);
  }

  await recordAuditEvent(ownerId, "password_changed", {});

  const newSession = await createSessionToken(ownerId, owner.mfaEnabled ? "high_assurance" : "password_only");
  return newSession;
}

// ----------------------------------------------------
// 4. CSRF Protection
// ----------------------------------------------------

export async function generateCsrfToken(sessionId) {
  const tokenValue = randomBytes(32).toString("hex");
  if (usePg()) {
    await csrfRepo.createToken(sessionId, tokenValue);
  } else {
    const csrf = {
      id: randomUUID(),
      sessionId,
      tokenValue,
      createdAt: new Date().toISOString()
    };
    dbCsrfTokens.set(csrf.id, csrf);
  }
  return tokenValue;
}

export async function verifyCsrfToken(sessionId, clientToken) {
  if (!clientToken) throw new Error("CSRF_TOKEN_REQUIRED");
  let matched = false;

  if (usePg()) {
    matched = await csrfRepo.verifyToken(sessionId, clientToken);
  } else {
    for (const c of dbCsrfTokens.values()) {
      if (c.sessionId === sessionId && c.tokenValue === clientToken) {
        matched = true;
        break;
      }
    }
  }

  if (!matched) {
    await recordAuditEvent(null, "csrf_rejected", { sessionId });
    throw new Error("INVALID_CSRF_TOKEN");
  }
  return true;
}

// ----------------------------------------------------
// 5. TOTP MFA Engine & Recovery Codes
// ----------------------------------------------------

export async function enrollTotpMfa(ownerId, sessionToken) {
  const session = await validateAndRetrieveSession(sessionToken);
  if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const secret = randomBytes(20).toString("hex");
  const encryptedSecret = encryptTotpSecret(secret);

  const enrollment = {
    id: randomUUID(),
    ownerId,
    encryptedTotpSecret: encryptedSecret,
    rawSecret: usePg() ? undefined : secret,
    lastUsedStep: null,
    isConfirmed: false,
    createdAt: new Date().toISOString()
  };

  if (usePg()) {
    await mfaRepo.createTotpEnrollment(enrollment);
  } else {
    dbTotpEnrollments.set(enrollment.id, enrollment);
  }

  return { enrollmentId: enrollment.id, secret };
}

export async function confirmTotpMfa(ownerId, enrollmentId, totpCode) {
  let enrollment = null;
  if (usePg()) {
    enrollment = await mfaRepo.findTotpEnrollment(enrollmentId);
  } else {
    enrollment = dbTotpEnrollments.get(enrollmentId);
  }

  if (!enrollment || enrollment.ownerId !== ownerId) {
    throw new Error("MFA_ENROLLMENT_NOT_FOUND");
  }

  const secret = enrollment.rawSecret || decryptTotpSecret(enrollment.encryptedTotpSecret || enrollment.encrypted_totp_secret);
  const usedStep = verifyTotpCode(secret, totpCode, enrollment.lastUsedStep ?? enrollment.last_used_step);
  if (usedStep === null) {
    throw new Error("INVALID_TOTP_CODE");
  }
  enrollment.lastUsedStep = usedStep;

  if (usePg()) {
    await mfaRepo.confirmTotpEnrollment(enrollmentId, ownerId, usedStep);
  } else {
    enrollment.isConfirmed = true;
    const owner = dbOwners.get(ownerId);
    if (owner) {
      owner.mfaEnabled = true;
      owner.status = "authenticated";
    }
  }

  // Generate 8 recovery codes
  const recoveryCodes = [];
  const hashedCodes = [];
  for (let i = 0; i < 8; i++) {
    const code = randomBytes(4).toString("hex");
    const codeHash = computeTokenHash(code);
    recoveryCodes.push(code);
    hashedCodes.push({
      id: randomUUID(),
      ownerId,
      codeHash,
      isUsed: false,
      createdAt: new Date().toISOString()
    });
  }

  if (usePg()) {
    await mfaRepo.saveRecoveryCodes(hashedCodes);
  } else {
    for (const hc of hashedCodes) {
      dbRecoveryCodes.set(hc.id, hc);
    }
  }

  await recordAuditEvent(ownerId, "mfa_challenge_succeeded", { action: "totp_enrolled" });

  return { recoveryCodes };
}

export async function verifyTotpAndElevateSession(ownerId, sessionToken, totpCode) {
  const session = await validateAndRetrieveSession(sessionToken);
  if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  let enrollment = null;
  if (usePg()) {
    enrollment = await mfaRepo.findConfirmedTotpEnrollment(ownerId);
  } else {
    for (const e of dbTotpEnrollments.values()) {
      if (e.ownerId === ownerId && e.isConfirmed) {
        enrollment = e;
        break;
      }
    }
  }

  if (!enrollment) throw new Error("MFA_NOT_ENROLLED");

  const secret = enrollment.rawSecret || decryptTotpSecret(enrollment.encryptedTotpSecret || enrollment.encrypted_totp_secret);
  let usedStep;
  try {
    usedStep = verifyTotpCode(secret, totpCode, enrollment.lastUsedStep ?? enrollment.last_used_step);
  } catch (error) {
    await recordAuditEvent(ownerId, "mfa_challenge_failed", { type: "totp", reason: "replay" });
    throw error;
  }
  if (usedStep === null) {
    await recordAuditEvent(ownerId, "mfa_challenge_failed", { type: "totp" });
    throw new Error("INVALID_TOTP_CODE");
  }
  enrollment.lastUsedStep = usedStep;
  if (usePg()) {
    const consumed = await mfaRepo.consumeTotpStep(enrollment.id, ownerId, usedStep);
    if (!consumed) throw new Error("REPLAYED_TOTP_CODE_REJECTED");
  }

  // Elevate and rotate token
  if (usePg()) {
    await sessionsRepo.revoke(session.id, ownerId);
  } else {
    const sessionObj = dbSessions.get(session.id);
    if (sessionObj) sessionObj.revokedAt = new Date().toISOString();
  }

  const elevated = await createSessionToken(ownerId, "high_assurance");
  await recordAuditEvent(ownerId, "mfa_challenge_succeeded", { type: "totp" });

  return elevated;
}

export async function useRecoveryCode(ownerId, code) {
  const normCodeHash = computeTokenHash(code);
  let success = false;

  if (usePg()) {
    success = await mfaRepo.verifyAndUseRecoveryCode(ownerId, normCodeHash);
  } else {
    let rcObj = null;
    for (const rc of dbRecoveryCodes.values()) {
      if (rc.ownerId === ownerId && rc.codeHash === normCodeHash) {
        rcObj = rc;
        break;
      }
    }
    if (rcObj && !rcObj.isUsed) {
      rcObj.isUsed = true;
      rcObj.used_at = new Date().toISOString();
      success = true;
    }
  }

  if (!success) {
    await recordAuditEvent(ownerId, "mfa_challenge_failed", { type: "recovery_code" });
    throw new Error("INVALID_OR_ALREADY_USED_RECOVERY_CODE");
  }

  await recordAuditEvent(ownerId, "mfa_challenge_succeeded", { type: "recovery_code" });
  return true;
}

// ----------------------------------------------------
// 7. Authorization Middleware Contracts
// ----------------------------------------------------

export async function requireAuthenticatedOwner(sessionToken) {
  const session = await validateAndRetrieveSession(sessionToken);
  return session.ownerId;
}

export async function requireMfaAssurance(sessionToken) {
  const session = await validateAndRetrieveSession(sessionToken);
  if (session.mfaAssuranceLevel !== "high_assurance") {
    throw new Error("MFA_ASSURANCE_REQUIRED");
  }
  return true;
}

export async function requireOwnerRole(ownerId, requiredRole = "owner") {
  let owner = null;
  if (usePg()) {
    owner = await ownersRepo.findById(ownerId);
  } else {
    owner = dbOwners.get(ownerId);
  }

  if (!owner || owner.role !== requiredRole) {
    throw new Error("INSUFFICIENT_PRIVILEGES");
  }
  return true;
}

// ----------------------------------------------------
// 8. Auditing Engine
// ----------------------------------------------------

export async function recordAuditEvent(ownerId, eventType, payload = {}) {
  const cleanPayload = sanitizeSecrets(payload);
  if (usePg()) {
    await auditRepo.recordEvent(ownerId, eventType, cleanPayload);
  } else {
    const event = {
      id: randomUUID(),
      ownerId,
      eventType,
      payload: cleanPayload,
      occurredAt: new Date().toISOString()
    };
    dbAuditEvents.set(event.id, event);
  }
  return { ownerId, eventType };
}

export async function listAuditEvents() {
  if (usePg()) {
    return await auditRepo.listEvents();
  }
  return deepFreeze(deepCopy(Array.from(dbAuditEvents.values())));
}
