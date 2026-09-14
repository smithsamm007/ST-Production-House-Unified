import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentRegistry } from "../catalog/agents.js";
import { initializeSeedState, retrieveActiveCharter, sanitizeSecrets } from "../catalog/creativeCharter.js";
import { createContentRunsRouter } from "./contentRunsRouter.js";
import { createOwnerControlRouter } from "./ownerControlRouter.js";

function safeCompareTokens(providedToken, expectedToken) {
  if (typeof providedToken !== "string" || typeof expectedToken !== "string") {
    return false;
  }
  const bufProvided = Buffer.from(providedToken, "utf8");
  const bufExpected = Buffer.from(expectedToken, "utf8");

  if (bufProvided.length !== bufExpected.length) {
    // Perform timingSafeEqual on expected vs expected to avoid timing leakage
    timingSafeEqual(bufExpected, bufExpected);
    return false;
  }

  return timingSafeEqual(bufProvided, bufExpected);
}

export function createOwnerApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  const sessions = options.sessionStore || new Map();
  const badAttempts = new Map();
  const defaultTtlMs = options.ttlMs || 30 * 60 * 1000; // 30 minutes

  // Rate Limiting helper
  function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    let record = badAttempts.get(ip);
    if (!record || now - record.windowStart > windowMs) {
      record = { count: 0, windowStart: now };
      badAttempts.set(ip, record);
    }
    return record;
  }

  function recordBadAttempt(ip) {
    const record = checkRateLimit(ip);
    record.count += 1;
  }

  // Middleware: requireAuth
  function requireAuth(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const limitRecord = checkRateLimit(ip);

    if (limitRecord.count >= 3) {
      return res.status(429).json({ error: "TOO_MANY_REQUESTS" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      recordBadAttempt(ip);
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      recordBadAttempt(ip);
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = sessions.get(tokenHash);

    if (!session || Date.now() >= session.expiresAt) {
      recordBadAttempt(ip);
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    req.session = session;
    next();
  }

  // GET /healthz (unauthenticated)
  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
  });

  // POST /session/start
  app.post("/session/start", (req, res) => {
    const bootstrapTokenEnv = options.bootstrapToken ?? process.env.STPH_BOOTSTRAP_TOKEN;

    if (!bootstrapTokenEnv || typeof bootstrapTokenEnv !== "string" || Buffer.byteLength(bootstrapTokenEnv, "utf8") < 32) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const candidateToken = req.body?.bootstrapToken || req.body?.token || (
      req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.substring(7).trim() : null
    );

    if (!candidateToken || !safeCompareTokens(candidateToken, bootstrapTokenEnv)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const sessionToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
    const now = Date.now();
    const expiresAt = now + defaultTtlMs;

    // Server-authoritative owner identity: the bootstrap token maps to one
    // owner; every scoped route reads the owner from the session, never from
    // client input.
    const ownerId = options.bootstrapOwnerId ?? "owner-01";
    const sessionData = {
      ownerId,
      createdAt: new Date(now).toISOString(),
      expiresAt,
    };

    sessions.set(tokenHash, sessionData);

    // Per-session CSRF material (S-M18-02): issued at session start, stored
    // server-side as a SHA-256 hash, required by every control mutation via
    // the `x-csrf-token` header. Sessions without CSRF material (e.g. created
    // before this feature) fail closed on mutations.
    const csrfToken = control.issueCsrfToken(sessions, tokenHash);

    return res.status(200).json({
      status: "success",
      token: sessionToken,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  // Protected read-only GET /agents
  app.get("/agents", requireAuth, (req, res) => {
    try {
      const agents = options.agents || new AgentRegistry().list();
      const sanitized = sanitizeSecrets(agents);
      return res.status(200).json(sanitized);
    } catch (err) {
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  // Protected read-only GET /charters
  app.get("/charters", requireAuth, (req, res) => {
    try {
      if (!options.charters) {
        initializeSeedState("owner-01");
      }
      const jarvisCharter = retrieveActiveCharter("agent-01");
      const lakmeCharter = retrieveActiveCharter("agent-03");
      const charters = options.charters || [jarvisCharter, lakmeCharter].filter(Boolean);
      const sanitized = sanitizeSecrets(charters);
      return res.status(200).json(sanitized);
    } catch (err) {
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  // Owner dashboard read surface (S-M18-01): content package runs + evidence
  // timeline. Mounted behind requireAuth so every route requires a valid
  // session; scoping uses the server-side session owner exclusively.
  app.use(
    "/content-runs",
    requireAuth,
    createContentRunsRouter({
      packageRunStore: options.packageRunStore,
      evidenceLedger: options.evidenceLedger
    })
  );

  // Owner control mutation surface (S-M18-02): job retry/cancel, approval
  // queue, and emergency pause. Mounted behind requireAuth; every mutation
  // additionally requires a per-session CSRF token (issued below at session
  // start) and writes an audit event. Scoping uses the server-side session
  // owner exclusively; resilience + audit dependencies degrade honestly (503)
  // when not configured.
  const control = createOwnerControlRouter({
    sessions,
    jobControlStore: options.jobControlStore ?? null,
    evidenceLedger: options.evidenceLedger ?? null,
    resilienceRepository: options.resilienceRepository ?? null,
    dbAdapter: options.dbAdapter ?? null
  });
  app.use(
    "/control",
    requireAuth,
    control
  );

  // Malformed / oversized JSON bodies fail closed as a clean 4xx (never 500, never leaked internals).
  app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large" || err?.status === 400 || err?.status === 413) {
      return res.status(err.status === 413 ? 413 : 400).json({ error: "REQUEST_BODY_INVALID" });
    }
    return next(err);
  });

  // Generic 404 for unknown endpoints
  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  // Global Error Handler (no stack trace leak)
  app.use((err, req, res, next) => {
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  });

  return app;
}

export function createOwnerServer(options = {}) {
  return createOwnerApp(options);
}

const defaultApp = createOwnerApp();
export default defaultApp;
