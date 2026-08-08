import express from "express";
import {
  registerOwner,
  loginOwner,
  logoutSession,
  validateAndRetrieveSession,
  generateCsrfToken,
  verifyCsrfToken,
  enrollTotpMfa,
  confirmTotpMfa,
  verifyTotpAndElevateSession,
  recordAuditEvent,
  requireOwnerRole,
  requireMfaAssurance,
  listAuditEvents,
  normalizeEmail
} from "./ownerAuthentication.js";
import {
  OwnerRepository,
  SessionRepository,
  AgentRepository,
  JobRepository,
  PublishingRepository,
  EvidenceLedgerRepository,
  AuditRepository,
  configureRepositoryAdapter
} from "./repositories.js";
import { createPostgresAdapter, sanitizeError } from "../db/index.js";

const app = express();
const postgres = createPostgresAdapter();
configureRepositoryAdapter(postgres);

// Set strict body size limit (e.g., 100kb max)
app.use(express.json({ limit: "100kb" }));

// Disable x-powered-by header
app.disable("x-powered-by");
app.set("trust proxy", Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
});

const ownersRepo = new OwnerRepository();
const sessionsRepo = new SessionRepository();
const agentsRepo = new AgentRepository();
const jobsRepo = new JobRepository();
const publishingRepo = new PublishingRepository();
const evidenceRepo = new EvidenceLedgerRepository();
const auditRepo = new AuditRepository();

const PUBLIC_ERROR_CODES = new Set([
  "EMAIL_AND_PASSWORD_REQUIRED", "INVALID_EMAIL_OR_PASSWORD", "ACCOUNT_TEMPORARILY_LOCKED",
  "SESSION_TOKEN_REQUIRED", "INVALID_SESSION_TOKEN", "SESSION_REVOKED",
  "SESSION_ABSOLUTE_EXPIRED", "SESSION_IDLE_EXPIRED", "SESSION_REVOKED_BY_REVOCATION_EPOCH",
  "CSRF_TOKEN_REQUIRED", "INVALID_CSRF_TOKEN", "MFA_ASSURANCE_REQUIRED",
  "MFA_ENROLLMENT_NOT_FOUND", "MFA_NOT_ENROLLED", "INVALID_TOTP_CODE",
  "REPLAYED_TOTP_CODE_REJECTED", "INVALID_OR_ALREADY_USED_RECOVERY_CODE",
  "INSUFFICIENT_PRIVILEGES", "AGENT_NOT_FOUND", "AGENT_CAP_REACHED",
  "DUPLICATE_AGENT_IDENTITY", "REQUEST_VALIDATION_FAILED"
]);

function publicError(error, fallback = "REQUEST_FAILED") {
  return PUBLIC_ERROR_CODES.has(error?.message) ? error.message : fallback;
}

function logInternalError(code, error) {
  const sanitized = sanitizeError(error);
  console.warn(JSON.stringify({ level: "error", code, errorName: sanitized.name || "Error" }));
}

function hasOnlyFields(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

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

// Utility to parse cookies manually
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
      return res.status(401).json({ error: "SESSION_TOKEN_REQUIRED" });
    }

    // Validate and retrieve session
    const session = await validateAndRetrieveSession(token);
    req.sessionToken = token;
    req.session = session;
    req.ownerId = session.ownerId;

    next();
  } catch (err) {
    const status = (err.message.includes("EXPIRED") || err.message === "INVALID_SESSION_TOKEN" || err.message === "SESSION_REVOKED" || err.message.includes("REVOCATION_EPOCH")) ? 401 : 403;
    return res.status(status).json({ error: publicError(err, "AUTHENTICATION_FAILED") });
  }
}

// CSRF Verification Middleware for Mutative Requests
async function requireCsrf(req, res, next) {
  const mutativeMethods = ["POST", "PUT", "DELETE", "PATCH"];
  if (!mutativeMethods.includes(req.method)) {
    return next();
  }

  // If request is authenticated via cookie, enforce CSRF
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;

  // Enforce CSRF strictly if cookie is present and Authorization Bearer header is absent
  if (cookies.session_token && (!authHeader || !authHeader.toLowerCase().startsWith("bearer "))) {
    try {
      const clientToken = req.headers["x-csrf-token"];
      if (!req.session?.id) {
        return res.status(403).json({ error: "SESSION_ID_REQUIRED_FOR_CSRF" });
      }
      await verifyCsrfToken(req.session.id, clientToken);
    } catch (err) {
      return res.status(403).json({ error: publicError(err, "CSRF_REJECTED") });
    }
  }
  next();
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health & Readiness Check Endpoints
app.get("/api/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/api/ready", async (req, res) => {
  try {
    await postgres.query("SELECT 1");
    return res.json({ status: "ready", database: { status: "healthy" } });
  } catch (error) {
    logInternalError("DATABASE_NOT_READY", error);
    return res.status(503).json({ status: "not_ready", database: { status: "unavailable" } });
  }
});

// 2. Owner Registration & Bootstrap Route
app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["email", "password"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "EMAIL_AND_PASSWORD_REQUIRED" });
    }

    const owner = await registerOwner(email, password, "owner");
    await recordAuditEvent(owner.id, "owner_registered", { email: owner.email });

    // Return safe DTO (no credentials, passwords)
    return res.status(201).json({
      id: owner.id,
      email: owner.email,
      role: owner.role,
      status: owner.status,
      createdAt: owner.createdAt
    });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 3. Login Route (Sets Secure HTTP-only Cookie and Generates CSRF Token)
app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["email", "password"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "EMAIL_AND_PASSWORD_REQUIRED" });
    }

    const { owner, session } = await loginOwner(email, password);

    // Generate CSRF token for the new session
    const csrfToken = await generateCsrfToken(session.session.id);

    // Set HTTP-only cookie with strict options
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
    return res.status(401).json({ error: publicError(err, "INVALID_EMAIL_OR_PASSWORD") });
  }
});

// 4. Logout Route
app.post("/api/auth/logout", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    await logoutSession(req.sessionToken);

    // Clear session cookie
    res.setHeader(
      "Set-Cookie",
      "session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"
    );

    return res.json({ status: "success", message: "Successfully logged out" });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 5. Authenticated Current Owner ("Me") Info
app.get("/api/auth/me", authenticateOwner, async (req, res) => {
  try {
    const owner = await ownersRepo.findById(req.ownerId);

    if (!owner) {
      return res.status(404).json({ error: "OWNER_NOT_FOUND" });
    }

    return res.json({
      id: owner.id,
      email: owner.email,
      role: owner.role,
      status: owner.status,
      mfaEnabled: owner.mfaEnabled,
    });
  } catch (err) {
    logInternalError("OWNER_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// 6. List Active Sessions
app.get("/api/auth/sessions", authenticateOwner, async (req, res) => {
  try {
    const list = await sessionsRepo.listActive(req.ownerId);
    return res.json(list);
  } catch (err) {
    logInternalError("SESSION_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// 7. Revoke Specific Session
app.delete("/api/auth/sessions/:id", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const revoked = await sessionsRepo.revoke(sessionId, req.ownerId);
    if (!revoked) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    await recordAuditEvent(req.ownerId, "session_revoked_manually", { sessionId });
    return res.json({ status: "success", message: `Session ${sessionId} revoked` });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 8. Revoke All Other Sessions
app.delete("/api/auth/sessions/other", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    await sessionsRepo.revokeAllOtherSessions(req.ownerId, req.session.id);
    await recordAuditEvent(req.ownerId, "other_sessions_revoked", {});
    return res.json({ status: "success", message: "All other sessions revoked successfully" });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 9. TOTP MFA Setup/Enroll
app.post("/api/auth/mfa/enroll", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const enroll = await enrollTotpMfa(req.ownerId, req.sessionToken);
    return res.json(enroll);
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 10. TOTP MFA Confirm Setup
app.post("/api/auth/mfa/confirm", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const { enrollmentId, totpCode } = req.body;
    if (!enrollmentId || !totpCode) {
      return res.status(400).json({ error: "ENROLLMENT_ID_AND_TOTP_CODE_REQUIRED" });
    }

    const confirm = await confirmTotpMfa(req.ownerId, enrollmentId, totpCode);
    return res.json(confirm);
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 11. TOTP MFA Verify and Elevate Session
app.post("/api/auth/mfa/verify", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const { totpCode } = req.body;
    if (!totpCode) {
      return res.status(400).json({ error: "TOTP_CODE_REQUIRED" });
    }

    const elevated = await verifyTotpAndElevateSession(req.ownerId, req.sessionToken, totpCode);

    // Set elevated cookie
    res.setHeader(
      "Set-Cookie",
      `session_token=${elevated.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`
    );

    return res.json({
      status: "success",
      session: {
        id: elevated.session.id,
        mfaAssuranceLevel: elevated.session.mfaAssuranceLevel,
        absoluteExpiresAt: elevated.session.absoluteExpiresAt,
        idleExpiresAt: elevated.session.idleExpiresAt,
      }
    });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// 12. List Preloaded & Registered Agents
app.get("/api/agents", authenticateOwner, async (req, res) => {
  try {
    const list = await agentsRepo.list();
    return res.json(list);
  } catch (err) {
    logInternalError("AGENT_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// 13. Retrieve Specific Agent
app.get("/api/agents/:id", authenticateOwner, async (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = await agentsRepo.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: "AGENT_NOT_FOUND" });
    }
    return res.json(agent);
  } catch (err) {
    logInternalError("AGENT_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// 14. Administer/Add New Agent (Max 50-Agent Hard Limit Check)
app.post("/api/agents", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["id", "name", "namespace", "enabled"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    await requireOwnerRole(req.ownerId, "owner"); // Only owners can add agents

    const { id, name, namespace, enabled } = req.body;
    if (!id || !name || !namespace) {
      return res.status(400).json({ error: "AGENT_ID_NAME_AND_NAMESPACE_REQUIRED" });
    }
    if (!/^agent-[a-z0-9-]{1,40}$/.test(id) ||
        !/^[A-Z][A-Z0-9_-]{1,49}$/.test(name) ||
        !/^st\.agent\.[a-z0-9-]{2,60}$/.test(namespace) ||
        (enabled !== undefined && typeof enabled !== "boolean")) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }

    const result = await agentsRepo.add({ id, name, namespace, enabled });

    await recordAuditEvent(req.ownerId, "agent_added", { agentId: id, name });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.get("/api/evidence", authenticateOwner, async (req, res) => {
  try {
    const list = await evidenceRepo.list();
    return res.json(list);
  } catch (err) {
    logInternalError("EVIDENCE_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// Error handling middleware to prevent stack traces/secrets leakage
app.use((err, req, res, next) => {
  logInternalError("UNHANDLED_API_ERROR", err);
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

export default app;
