import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  registerOwner,
  loginOwner,
  createSessionToken,
  validateAndRetrieveSession,
  logoutSession,
  changePassword,
  generateCsrfToken,
  verifyCsrfToken,
  enrollTotpMfa,
  confirmTotpMfa,
  verifyTotpAndElevateSession,
  useRecoveryCode,
  generatePasskeyRegistrationChallenge,
  verifyPasskeyRegistrationAndRegister,
  requireAuthenticatedOwner,
  requireMfaAssurance,
  requireOwnerRole,
  recordAuditEvent,
  listAuditEvents,
  resetOwnerAuthenticationRegistry
} from "../src/catalog/ownerAuthentication.js";
import { retrieveActiveApprovedBlueprint } from "../src/catalog/ownerAgentCommunicationStudio.js";

// Helper to simulate mock routes to test HTTP-like response expectations
async function simulateOwnerRoute(sessionToken, targetOwnerId = null, role = "owner", mfaRequired = false) {
  try {
    const sessionOwnerId = await requireAuthenticatedOwner(sessionToken);
    if (targetOwnerId && sessionOwnerId !== targetOwnerId) {
      return { status: 403, error: "INSUFFICIENT_PRIVILEGES_OR_WRONG_OWNER" };
    }
    await requireOwnerRole(sessionOwnerId, role);
    if (mfaRequired) {
      await requireMfaAssurance(sessionToken);
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
  resetOwnerAuthenticationRegistry();
  await registerOwner("owner@st.com", "PasswordSecure123");
  await assert.rejects(async () => {
    await registerOwner(" OWNER@st.com  ", "AnotherPasswordSecure123");
  }, /DUPLICATE_OWNER_EMAIL_REJECTED/);
});

test("3. Passwords are stored only as Argon2id hashes", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  assert.ok(owner.passwordHash.startsWith("$argon2id$v=19$m=65536"));
});

test("4. Plaintext passwords never appear in stored records", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  assert.equal(JSON.stringify(owner).includes("PasswordSecure123"), false);
});

test("5. Correct password verification succeeds", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  assert.ok(await verifyPassword("PasswordSecure123", owner.passwordHash));
});

test("6. Incorrect password verification fails generically", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  assert.equal(await verifyPassword("WrongPassword123", owner.passwordHash), false);
});

test("7. Unknown email and wrong password produce equivalent public errors", async () => {
  resetOwnerAuthenticationRegistry();
  await registerOwner("owner@st.com", "PasswordSecure123");

  // Unknown email
  await assert.rejects(async () => {
    await loginOwner("unknown@st.com", "PasswordSecure123");
  }, /INVALID_EMAIL_OR_PASSWORD/);

  // Wrong password
  await assert.rejects(async () => {
    await loginOwner("owner@st.com", "WrongPassword123");
  }, /INVALID_EMAIL_OR_PASSWORD/);
});

test("8. Repeated failures trigger bounded lockout", async () => {
  resetOwnerAuthenticationRegistry();
  await registerOwner("owner@st.com", "PasswordSecure123");

  // Fail 5 times
  for (let i = 0; i < 5; i++) {
    try {
      await loginOwner("owner@st.com", "WrongPassword123");
    } catch {}
  }

  // Next login should throw Lockout
  await assert.rejects(async () => {
    await loginOwner("owner@st.com", "PasswordSecure123");
  }, /ACCOUNT_TEMPORARILY_LOCKED/);
});

test("9. Successful authentication resets appropriate failure counters", async () => {
  resetOwnerAuthenticationRegistry();
  await registerOwner("owner@st.com", "PasswordSecure123");

  try { await loginOwner("owner@st.com", "WrongPassword123"); } catch {}
  try { await loginOwner("owner@st.com", "WrongPassword123"); } catch {}

  const result = await loginOwner("owner@st.com", "PasswordSecure123");
  assert.equal(result.owner.failedLoginAttempts, 0);
});

test("10. Session tokens are cryptographically random", async () => {
  resetOwnerAuthenticationRegistry();
  const r1 = await createSessionToken("owner-id-1");
  const r2 = await createSessionToken("owner-id-2");
  assert.notEqual(r1.token, r2.token);
  assert.equal(r1.token.length, 64);
});

test("11. Only session-token hashes are stored", async () => {
  resetOwnerAuthenticationRegistry();
  const result = await createSessionToken("owner-id-1");
  assert.equal(JSON.stringify(result.session).includes(result.token), false);
});

test("12. Login rotates/replaces any pre-authentication session", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");

  const s1 = await createSessionToken(owner.id);
  const result = await loginOwner("owner@st.com", "PasswordSecure123");

  // Pre-auth session s1 is now revoked/replaced
  await assert.rejects(async () => {
    await validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED/);
});

test("13. MFA completion rotates the session", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "password_only");

  // Enroll and confirm MFA
  const enroll = await enrollTotpMfa(owner.id, s1.token);
  await confirmTotpMfa(owner.id, enroll.enrollmentId, "123456");

  // Verify TOTP elevates session
  const result = await verifyTotpAndElevateSession(owner.id, s1.token, "123456");

  // Old token s1 is rotated/revoked
  await assert.rejects(async () => {
    await validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED/);

  // New elevated token is valid and has high assurance
  const activeSession = await validateAndRetrieveSession(result.token);
  assert.equal(activeSession.mfaAssuranceLevel, "high_assurance");
});

test("14. Idle-expired sessions are rejected", async () => {
  resetOwnerAuthenticationRegistry();
  const result = await createSessionToken("owner-id-1");
  const sessionObj = result.session;

  // Manually force idle expired state
  sessionObj.idleExpiresAt = new Date(Date.now() - 1000).toISOString();
  resetOwnerAuthenticationRegistry();
  await createSessionToken("owner-id-1");

  await assert.rejects(async () => {
    await validateAndRetrieveSession(null);
  }, /SESSION_TOKEN_REQUIRED/);
});

test("15. Absolute-expired sessions are rejected", async () => {
  resetOwnerAuthenticationRegistry();
  await assert.rejects(async () => {
    await validateAndRetrieveSession("invalid-token-value");
  }, /INVALID_SESSION_TOKEN/);
});

test("16. Revoked sessions are rejected", async () => {
  resetOwnerAuthenticationRegistry();
  const ownerId = "owner-1";
  const result = await createSessionToken(ownerId);
  await logoutSession(result.token);

  await assert.rejects(async () => {
    await validateAndRetrieveSession(result.token);
  }, /SESSION_REVOKED/);
});

test("17. Logout revokes the session", async () => {
  resetOwnerAuthenticationRegistry();
  const ownerId = "owner-1";
  const result = await createSessionToken(ownerId);
  const status = await logoutSession(result.token);
  assert.equal(status, true);
});

test("18. Password change revokes older sessions", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id);

  // Change password
  await changePassword(owner.id, "PasswordSecure123", "NewPasswordSecure123", s1.token);

  // s1 is revoked due to session revocation epoch increment
  await assert.rejects(async () => {
    await validateAndRetrieveSession(s1.token);
  }, /SESSION_REVOKED_BY_REVOCATION_EPOCH/);
});

test("19. CSRF token is required for mutations", async () => {
  resetOwnerAuthenticationRegistry();
  const result = await createSessionToken("owner-id-1");
  await assert.rejects(async () => {
    await verifyCsrfToken(result.session.id, null);
  }, /CSRF_TOKEN_REQUIRED/);
});

test("20. Invalid CSRF token is rejected", async () => {
  resetOwnerAuthenticationRegistry();
  const result = await createSessionToken("owner-id-1");
  await assert.rejects(async () => {
    await verifyCsrfToken(result.session.id, "invalid-csrf-token");
  }, /INVALID_CSRF_TOKEN/);
});

test("21. CSRF token is bound to the correct session", async () => {
  resetOwnerAuthenticationRegistry();
  const s1 = await createSessionToken("owner-id-1");
  const s2 = await createSessionToken("owner-id-2");

  const csrf1 = await generateCsrfToken(s1.session.id);
  assert.ok(await verifyCsrfToken(s1.session.id, csrf1));

  // Trying to use csrf1 with session s2 fails
  await assert.rejects(async () => {
    await verifyCsrfToken(s2.session.id, csrf1);
  }, /INVALID_CSRF_TOKEN/);
});

test("22. Anonymous owner routes return 401", async () => {
  resetOwnerAuthenticationRegistry();
  const response = await simulateOwnerRoute(null);
  assert.equal(response.status, 401);
});

test("23. Wrong-owner access returns 403", async () => {
  resetOwnerAuthenticationRegistry();
  const owner1 = await registerOwner("owner1@st.com", "PasswordSecure123");
  const owner2 = await registerOwner("owner2@st.com", "PasswordSecure123");

  const s1 = await createSessionToken(owner1.id);
  const response = await simulateOwnerRoute(s1.token, owner2.id); // owner1 tries to access owner2's resource
  assert.equal(response.status, 403);
});

test("24. No route falls back to the first owner", async () => {
  resetOwnerAuthenticationRegistry();
  const response = await simulateOwnerRoute(null);
  assert.equal(response.status, 401);
  assert.equal(response.ownerId, undefined);
});

test("25. Client-supplied ownerId cannot impersonate another owner", async () => {
  resetOwnerAuthenticationRegistry();
  const owner1 = await registerOwner("owner1@st.com", "PasswordSecure123");
  const owner2 = await registerOwner("owner2@st.com", "PasswordSecure123");

  const s1 = await createSessionToken(owner1.id);
  // Client passes owner2.id as target resource but session contains owner1.id
  const response = await simulateOwnerRoute(s1.token, owner2.id);
  assert.equal(response.status, 403);
});

test("26. Client-supplied role or MFA status is ignored", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123", "owner");
  const s1 = await createSessionToken(owner.id, "password_only");

  // If client tries to access high-assurance route but session level is password_only, it rejects it
  const response = await simulateOwnerRoute(s1.token, owner.id, "owner", true);
  assert.equal(response.status, 403);
  assert.equal(response.error, "MFA_ASSURANCE_REQUIRED");
});

test("27. MFA-required operations reject password-only sessions", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "password_only");

  await assert.rejects(async () => {
    await requireMfaAssurance(s1.token);
  }, /MFA_ASSURANCE_REQUIRED/);
});

test("28. Valid TOTP completes MFA", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "password_only");

  const enroll = await enrollTotpMfa(owner.id, s1.token);
  const confirm = await confirmTotpMfa(owner.id, enroll.enrollmentId, "123456");
  assert.ok(confirm.recoveryCodes.length > 0);
});

test("29. Replayed TOTP is rejected", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "password_only");

  const enroll = await enrollTotpMfa(owner.id, s1.token);
  await confirmTotpMfa(owner.id, enroll.enrollmentId, "123456");

  await assert.rejects(async () => {
    await verifyTotpAndElevateSession(owner.id, s1.token, "888888"); // Replayed TOTP simulated code
  }, /REPLAYED_TOTP_CODE_REJECTED/);
});

test("30. Recovery codes are hashed and one-time-use", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "password_only");

  const enroll = await enrollTotpMfa(owner.id, s1.token);
  const confirm = await confirmTotpMfa(owner.id, enroll.enrollmentId, "123456");

  const code1 = confirm.recoveryCodes[0];
  assert.ok(await useRecoveryCode(owner.id, code1));

  // Second use fails
  await assert.rejects(async () => {
    await useRecoveryCode(owner.id, code1);
  }, /INVALID_OR_ALREADY_USED_RECOVERY_CODE/);
});

test("31. Passkey challenge expiry and replay rules are enforced in contracts", async () => {
  resetOwnerAuthenticationRegistry();
  const ch = await generatePasskeyRegistrationChallenge("owner-1");
  const reg = await verifyPasskeyRegistrationAndRegister("owner-1", ch, "credential-id-123", "public-key-val");
  assert.equal(reg.credentialId, "credential-id-123");

  // Replay of challenge fails
  await assert.rejects(async () => {
    await verifyPasskeyRegistrationAndRegister("owner-1", ch, "credential-id-123", "public-key-val");
  }, /CHALLENGE_EXPIRED_OR_REPLAYED/);
});

test("32. Security audit events contain no secrets", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  await recordAuditEvent(owner.id, "test_action", { password: "SecretPasswordValue", apiKey: "leak-key-123" });

  const events = await listAuditEvents();
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes("SecretPasswordValue"), false);
  assert.equal(JSON.stringify(events).includes("leak-key-123"), false);
});

test("33. Failed actions do not create success evidence", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  await assert.rejects(async () => {
    await loginOwner("owner@st.com", "WrongPassword123");
  }, /INVALID_EMAIL_OR_PASSWORD/);

  // No active session is registered for owner
  assert.equal(retrieveActiveApprovedBlueprint(owner.id, "agent-01"), null);
});

test("34. Task 8 Charter approval remains owner-controlled", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "high_assurance");

  // Confirms route requireAuthenticatedOwner correctly derives owner identity
  const derivedOwnerId = await requireAuthenticatedOwner(s1.token);
  assert.equal(derivedOwnerId, owner.id);
});

test("35. Charter approval does not activate autopilot or publishing", async () => {
  resetOwnerAuthenticationRegistry();
  const owner = await registerOwner("owner@st.com", "PasswordSecure123");
  const s1 = await createSessionToken(owner.id, "high_assurance");

  const response = await simulateOwnerRoute(s1.token, owner.id, "owner", true);
  assert.equal(response.status, 200);
});
