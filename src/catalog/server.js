import express from "express";
import {
  normalizeEmail,
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  OwnerAuthenticationService
} from "./ownerAuthentication.js";
import {
  OwnerRepository,
  SessionRepository,
  AgentRepository,
  JobRepository,
  PublishingRepository,
  EvidenceLedgerRepository,
  AuditRepository,
  dbAdapter,
  checkDatabaseHealth
} from "./repositories.js";

// Map internal error messages to safe, sanitized public error codes (Blocker #6)
function getPublicErrorCode(err) {
  const msg = err.message || "";
  if (msg.includes("PASSWORD_TOO_SHORT") || msg.includes("PASSWORD_IS_COMMON") || msg.includes("PASSWORD_EXCEEDS")) {
    return "PASSWORD_POLICY_VIOLATION";
  }
  if (msg.includes("DUPLICATE_OWNER_EMAIL_REJECTED")) {
    return "EMAIL_ALREADY_REGISTERED";
  }
  if (msg.includes("INVALID_EMAIL_OR_PASSWORD") || msg.includes("INVALID_OLD_PASSWORD")) {
    return "INVALID_CREDENTIALS";
  }
  if (msg.includes("ACCOUNT_TEMPORARILY_LOCKED")) {
    return "LOCKOUT_ACTIVE";
  }
  if (msg.includes("SESSION_TOKEN_REQUIRED") || msg.includes("INVALID_SESSION_TOKEN")) {
    return "UNAUTHORIZED";
  }
  if (msg.includes("SESSION_REVOKED") || msg.includes("SESSION_ABSOLUTE_EXPIRED") || msg.includes("SESSION_IDLE_EXPIRED")) {
    return "SESSION_EXPIRED_OR_REVOKED";
  }
  if (msg.includes("CSRF_TOKEN_REQUIRED") || msg.includes("INVALID_CSRF_TOKEN")) {
    return "CSRF_VALIDATION_FAILED";
  }
  if (msg.includes("MFA_ASSURANCE_REQUIRED")) {
    return "MFA_ELEVATION_REQUIRED";
  }
  if (msg.includes("MFA_ENROLLMENT_NOT_FOUND")) {
    return "MFA_ENROLLMENT_INVALID";
  }
  if (msg.includes("INVALID_TOTP_CODE")) {
    return "MFA_CODE_INVALID";
  }
  if (msg.includes("REPLAYED_TOTP_CODE_REJECTED")) {
    return "MFA_CODE_REPLAYED";
  }
  if (msg.includes("AGENT_CAP_REACHED")) {
    return "AGENT_LIMIT_EXCEEDED";
  }
  if (msg.includes("INSUFFICIENT_PRIVILEGES")) {
    return "FORBIDDEN";
  }
  return "INTERNAL_SERVER_ERROR";
}

// Simple cookie parser helper
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

// Explicit application factory with injected repositories/adapters (Blocker #2)
export function createApp(repos = {}, customAuthService = null) {
  const app = express();

  // Set strict body size limit (e.g., 100kb max)
  app.use(express.json({ limit: "100kb" }));

  // Disable x-powered-by header
  app.disable("x-powered-by");

  // Instantiate standard production-grade repositories using canonical dbAdapter
  const ownersRepo = repos.ownersRepo || new OwnerRepository(dbAdapter);
  const sessionsRepo = repos.sessionsRepo || new SessionRepository(dbAdapter);
  const agentsRepo = repos.agentsRepo || new AgentRepository(dbAdapter);
  const jobsRepo = repos.jobsRepo || new JobRepository(dbAdapter);
  const publishingRepo = repos.publishingRepo || new PublishingRepository(dbAdapter);
  const evidenceRepo = repos.evidenceRepo || new EvidenceLedgerRepository(dbAdapter);
  const auditRepo = repos.auditRepo || new AuditRepository(dbAdapter);

  // Instaniate explicit auth service with injected repositories
  const auth = customAuthService || new OwnerAuthenticationService({
    ownersRepo,
    sessionsRepo,
    mfaRepo: repos.mfaRepo, // will default to new MfaRepository() internally if not passed
    csrfRepo: repos.csrfRepo,
    auditRepo
  });

  // Simple endpoint rate limiter for auth routes
  const authIpLimiter = new Map();
  function rateLimitAuth(req, res, next) {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const now = Date.now();
    const limitWindow = 60 * 1000; // 1 minute
    const maxRequests = 10;

    let clientRecord = authIpLimiter.get(ip);
    if (!clientRecord) {
      clientRecord = { count: 1, firstRequest: now };
      authIpLimiter.set(ip, clientRecord);
    } else {
      if (now - clientRecord.firstRequest > limitWindow) {
        clientRecord.count = 1;
        clientRecord.firstRequest = now;
      } else {
        clientRecord.count += 1;
      }
    }

    if (clientRecord.count > maxRequests) {
      return res.status(429).json({ error: "TOO_MANY_REQUESTS_TRY_AGAIN_LATER" });
    }
    next();
  }

  // Authentication Middleware
  async function authenticateOwner(req, res, next) {
    try {
      let token = null;

      // 1. Try to extract from Authorization Bearer header
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        token = authHeader.substring(7).trim();
      }

      // 2. Try to extract from cookie
      if (!token && req.headers.cookie) {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies.session_token) {
          token = cookies.session_token;
        }
      }

      if (!token) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }

      // Validate and retrieve session
      const session = await auth.validateAndRetrieveSession(token);
      req.sessionToken = token;
      req.session = session;
      req.ownerId = session.ownerId;

      next();
    } catch (err) {
      return res.status(401).json({ error: getPublicErrorCode(err) });
    }
  }

  // CSRF Verification Middleware for Mutative Requests
  async function requireCsrf(req, res, next) {
    const mutativeMethods = ["POST", "PUT", "DELETE", "PATCH"];
    if (!mutativeMethods.includes(req.method)) {
      return next();
    }

    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization;

    // Enforce CSRF strictly if cookie is present and Authorization Bearer header is absent
    if (cookies.session_token && (!authHeader || !authHeader.toLowerCase().startsWith("bearer "))) {
      try {
        const clientToken = req.headers["x-csrf-token"];
        if (!req.session?.id) {
          return res.status(403).json({ error: "CSRF_VALIDATION_FAILED" });
        }
        await auth.verifyCsrfToken(req.session.id, clientToken);
      } catch (err) {
        return res.status(403).json({ error: getPublicErrorCode(err) });
      }
    }
    next();
  }

  // 1. Health Check Endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  app.get("/api/ready", async (req, res) => {
    const health = await checkDatabaseHealth();
    if (health.status === "healthy") {
      return res.json({ status: "ready", database: health });
    } else {
      return res.status(503).json({ status: "not_ready", database: health });
    }
  });

  // 2. Owner Registration
  app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
    try {
      // Reject unknown request body fields and client-selected roles
      const allowedKeys = ["email", "password"];
      const bodyKeys = Object.keys(req.body || {});
      for (const k of bodyKeys) {
        if (!allowedKeys.includes(k)) {
          return res.status(400).json({ error: "INVALID_CREDENTIALS" });
        }
      }

      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "INVALID_CREDENTIALS" });
      }

      let callerSessionToken = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        callerSessionToken = authHeader.substring(7).trim();
      } else if (req.headers.cookie) {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies.session_token) {
          callerSessionToken = cookies.session_token;
        }
      }

      const owner = await auth.registerOwner(email, password, callerSessionToken);
      await auth.recordAuditEvent(owner.id, "owner_registered", { email: owner.email });

      return res.status(201).json({
        id: owner.id,
        email: owner.email,
        role: owner.role,
        status: owner.status,
        createdAt: owner.createdAt
      });
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 3. Login Route
  app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "INVALID_CREDENTIALS" });
      }

      const { owner, session } = await auth.loginOwner(email, password);
      const csrfToken = await auth.generateCsrfToken(session.session.id);

      res.setHeader(
        "Set-Cookie",
        `session_token=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`
      );

      return res.json({
        status: "success",
        owner: {
          id: owner.id,
          email: owner.email,
          role: owner.role,
          status: owner.status,
          mfaEnabled: owner.mfaEnabled,
        },
        csrfToken,
        session: {
          id: session.session.id,
          mfaAssuranceLevel: session.session.mfaAssuranceLevel,
          absoluteExpiresAt: session.session.absoluteExpiresAt,
          idleExpiresAt: session.session.idleExpiresAt,
        }
      });
    } catch (err) {
      return res.status(401).json({ error: getPublicErrorCode(err) });
    }
  });

  // 4. Logout Route
  app.post("/api/auth/logout", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      await auth.logoutSession(req.sessionToken);
      res.setHeader(
        "Set-Cookie",
        "session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"
      );
      return res.json({ status: "success", message: "Successfully logged out" });
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 5. Authenticated Current Owner ("Me")
  app.get("/api/auth/me", authenticateOwner, async (req, res) => {
    try {
      const owner = await ownersRepo.findById(req.ownerId);
      if (!owner) {
        return res.status(404).json({ error: "UNAUTHORIZED" });
      }

      return res.json({
        id: owner.id,
        email: owner.email,
        role: owner.role,
        status: owner.status,
        mfaEnabled: owner.mfaEnabled,
      });
    } catch (err) {
      return res.status(500).json({ error: getPublicErrorCode(err) });
    }
  });

  // 6. List Active Sessions
  app.get("/api/auth/sessions", authenticateOwner, async (req, res) => {
    try {
      const list = await sessionsRepo.listActive(req.ownerId);
      return res.json(list);
    } catch (err) {
      return res.status(500).json({ error: getPublicErrorCode(err) });
    }
  });

  // 7. Revoke Specific Session (Blocker #5: Requires matching owner_id!)
  app.delete("/api/auth/sessions/:id", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      const sessionId = req.params.id;
      const revoked = await sessionsRepo.revokeWithOwner(sessionId, req.ownerId);
      if (!revoked) {
        return res.status(404).json({ error: "UNAUTHORIZED" });
      }
      await auth.recordAuditEvent(req.ownerId, "session_revoked_manually", { sessionId });
      return res.json({ status: "success", message: `Session ${sessionId} revoked` });
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 8. Revoke All Other Sessions
  app.delete("/api/auth/sessions/other", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      await sessionsRepo.revokeAllOtherSessions(req.ownerId, req.session.id);
      await auth.recordAuditEvent(req.ownerId, "other_sessions_revoked", {});
      return res.json({ status: "success", message: "All other sessions revoked successfully" });
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 9. TOTP MFA Setup/Enroll
  app.post("/api/auth/mfa/enroll", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      const enroll = await auth.enrollTotpMfa(req.ownerId, req.sessionToken);
      return res.json(enroll);
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 10. TOTP MFA Confirm Setup
  app.post("/api/auth/mfa/confirm", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      const { enrollmentId, totpCode } = req.body;
      if (!enrollmentId || !totpCode) {
        return res.status(400).json({ error: "MFA_CODE_INVALID" });
      }

      const confirm = await auth.confirmTotpMfa(req.ownerId, enrollmentId, totpCode);
      return res.json(confirm);
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 11. TOTP MFA Verify and Elevate Session
  app.post("/api/auth/mfa/verify", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      const { totpCode } = req.body;
      if (!totpCode) {
        return res.status(400).json({ error: "MFA_CODE_INVALID" });
      }

      const elevated = await auth.verifyTotpAndElevateSession(req.ownerId, req.sessionToken, totpCode);

      res.setHeader(
        "Set-Cookie",
        `session_token=${elevated.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`
      );

      return res.json({
        status: "success",
        csrfToken: elevated.csrfToken,
        session: {
          id: elevated.session.id,
          mfaAssuranceLevel: elevated.session.mfaAssuranceLevel,
          absoluteExpiresAt: elevated.session.absoluteExpiresAt,
          idleExpiresAt: elevated.session.idleExpiresAt,
        }
      });
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 12. List Preloaded & Registered Agents
  app.get("/api/agents", authenticateOwner, async (req, res) => {
    try {
      const list = await agentsRepo.list();
      return res.json(list);
    } catch (err) {
      return res.status(500).json({ error: getPublicErrorCode(err) });
    }
  });

  // 13. Retrieve Specific Agent
  app.get("/api/agents/:id", authenticateOwner, async (req, res) => {
    try {
      const agentId = req.params.id;
      const agent = await agentsRepo.get(agentId);
      if (!agent) {
        return res.status(404).json({ error: "AGENT_LIMIT_EXCEEDED" });
      }
      return res.json(agent);
    } catch (err) {
      return res.status(500).json({ error: getPublicErrorCode(err) });
    }
  });

  // 14. Administer/Add New Agent (Max 50-Agent Hard Limit Check)
  app.post("/api/agents", authenticateOwner, requireCsrf, async (req, res) => {
    try {
      await auth.requireOwnerRole(req.ownerId, "owner"); // Only owners can add agents

      const { id, name, namespace, enabled } = req.body;
      if (!id || !name || !namespace) {
        return res.status(400).json({ error: "AGENT_LIMIT_EXCEEDED" });
      }

      const result = await agentsRepo.add({ id, name, namespace, enabled });
      await auth.recordAuditEvent(req.ownerId, "agent_added", { agentId: id, name });
      return res.status(201).json(result);
    } catch (err) {
      return res.status(400).json({ error: getPublicErrorCode(err) });
    }
  });

  // 15. Evidence Ledger Route
  app.get("/api/evidence", authenticateOwner, async (req, res) => {
    try {
      const list = await evidenceRepo.list();
      return res.json(list);
    } catch (err) {
      return res.status(500).json({ error: getPublicErrorCode(err) });
    }
  });

  // Secure Error Handling Middleware to prevent leaks (Blocker #6)
  app.use((err, req, res, next) => {
    const correlationId = randomBytes(16).toString("hex");
    const eventCode = "UNHANDLED_SERVER_ERROR";
    console.error(`[${eventCode}] correlation_id=${correlationId}`);
    res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      correlationId
    });
  });

  return app;
}

// Export a default app using the standard database repositories for backwards compatibility
const defaultApp = createApp();
export default defaultApp;
