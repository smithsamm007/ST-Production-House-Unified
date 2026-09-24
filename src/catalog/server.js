/**
 * ST Production House — main API surface.
 *
 * Storage modes (chosen by server.js via configureRuntime):
 *   - postgres (production): DATABASE_URL / PG* env, migrations from sql/.
 *   - demo (STPH_DEMO_STORAGE=1): labeled non-durable adapter so the complete
 *     product runs without a DB server. /api/health reports storage:"demo".
 *
 * Security posture preserved from the reviewed codebase: strict body limits,
 * security headers, session auth (Bearer or HttpOnly cookie), CSRF on cookie
 * mutations, parameterized repositories, safe DTO serialization, allowlisted
 * public error codes.
 *
 * New in this surface:
 *   - GET /api/channels + GET /api/channels/:id — the multi-channel anime
 *     production view (public channel brands; internal agent names never leave).
 *   - POST /api/productions — queue an episode production job for a channel.
 *   - GET /api/metrics — authenticated operational counters.
 *   - POST /api/auth/register is gated: open only until the first owner exists
 *     (OWNER_BOOTSTRAP_ALREADY_COMPLETED afterwards), preventing public takeover.
 */

import express from "express";
import { registerOwner, loginOwner, logoutSession, validateAndRetrieveSession, generateCsrfToken, verifyCsrfToken, enrollTotpMfa, confirmTotpMfa, verifyTotpAndElevateSession, recordAuditEvent, requireOwnerRole, listAuditEvents, normalizeEmail } from "./ownerAuthentication.js";
import { OwnerRepository, SessionRepository, AgentRepository, JobRepository, PublishingRepository, EvidenceLedgerRepository, AuditRepository, configureRepositoryAdapter } from "./repositories.js";
import { createPostgresAdapter, sanitizeError } from "../db/index.js";
import { createDemoStorageAdapter } from "../db/demoStorageAdapter.js";
import { createContentRunsRouter } from "../api/contentRunsRouter.js";
import { createProviderCatalogRouter, createDirectorConnectionsRouter } from "../api/directorConnectionsRouter.js";
import { createOwnerControlRouter } from "../api/ownerControlRouter.js";
import { PostgresOwnerControlStore } from "../api/ownerControlStore.js";
import { ProductionRepository, isKnownPlatform, isValidChannelSlug } from "../catalog/productionRepository.js";
import { DirectorWorkspaceRepository } from "../catalog/directorWorkspaceRepository.js";
import { evaluatePublishGate, runEpisodePipeline } from "../pipeline/episodePipeline.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10));

let postgres = null;
let storageMode = "postgres";
let ownerControlStore = null;
let productionWorker = null;

/** Test/diagnostic hook: exposes the active demo adapter (null in postgres mode). */
export let __demoAdapterForDiagnostics = null;

export async function configureRuntime() {
  const wantsDemo = process.env.STPH_DEMO_STORAGE === "1";
  const strictPostgres = process.env.STPH_STRICT_POSTGRES === "1";
  const hasDbConfig = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGHOST || process.env.POSTGRES_HOST);

  if (wantsDemo || (!hasDbConfig && !strictPostgres)) {
    // Labeled demo storage: NON-DURABLE, process-local, and always surfaced
    // truthfully by /api/health (storage:"demo"). Production sets DATABASE_URL
    // (or STPH_STRICT_POSTGRES=1 to refuse fallback).
    if (!wantsDemo) {
      console.warn(
        JSON.stringify({
          level: "warn",
          code: "DEMO_STORAGE_FALLBACK",
          message: "No DATABASE_URL configured; using labeled NON-DURABLE demo storage.",
        })
      );
    }
    storageMode = "demo";
    postgres = createDemoStorageAdapter();
    __demoAdapterForDiagnostics = postgres;
  } else if (!hasDbConfig) {
    // Honest degraded boot: strict mode, no DB configured.
    storageMode = "unconfigured";
    postgres = null;
    return { storageMode };
  } else {
    storageMode = "postgres";
    postgres = createPostgresAdapter();
  }

  configureRepositoryAdapter(postgres);

  // Migrations run in BOTH modes: the demo adapter interprets the DDL subset
  // (tables + column defaults) so demo data lands in correctly-shaped tables.
  const { runMigrations } = await import("../db/index.js");
  await runMigrations(postgres);

  ownerControlStore = new PostgresOwnerControlStore(postgres, new EvidenceLedgerRepository());
  return { storageMode };
}

/**
 * One-time boot finalization (called by server.js after listen): in demo mode
 * seeds labeled demo data; in any mode starts the opt-in production worker.
 * Failures are logged honestly and never fake a healthy state.
 */
export async function finalizeRuntimeStartup() {
  if (storageMode === "demo") {
    try {
      await seedDemoData();
    } catch (error) {
      logInternalError("DEMO_SEED_FAILED", error);
    }
  }
  if (process.env.STPH_ENABLE_WORKERS === "1" && postgres) {
    try {
      const { ProductionWorkerLoop } = await import("../pipeline/workerLoop.js");
      const { AgentRepository } = await import("./repositories.js");
      const agentsRepo = new AgentRepository();
      productionWorker = new ProductionWorkerLoop({
        jobsRepository: new JobRepository(),
        productionRepository: new ProductionRepository(postgres),
        evidenceLedger: new EvidenceLedgerRepository(),
        enabledAgentsProvider: async () => (await agentsRepo.list()).filter((a) => a.enabled !== false),
      });
      productionWorker.start();
    } catch (error) {
      logInternalError("WORKER_START_FAILED", error);
    }
  }
  return { storageMode, workerStarted: productionWorker !== null };
}

/** Exposed for graceful shutdown and tests. */
export function getProductionWorker() {
  return productionWorker;
}/** Demo-mode bootstrap: seed canonical agents + a demo owner + starter channels. */
export async function seedDemoData() {
  if (storageMode !== "demo") return { seeded: false };
  const agentsRepo = new AgentRepository();
  const ownersRepo = new OwnerRepository();
  const jobsRepo = new JobRepository();
  const evidenceRepo = new EvidenceLedgerRepository();

  for (const agent of AGENT_SEED) {
    try {
      await agentsRepo.add(agent);
    } catch (error) {
      if (error.message !== "DUPLICATE_AGENT_IDENTITY") throw error;
    }
  }

  const demoEmail = "owner@stproduction.demo";
  let owner = await ownersRepo.findByEmail(demoEmail);
  if (!owner) {
    const { hashPassword } = await import("./ownerAuthentication.js");
    const passwordHash = await hashPassword(process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026");
    owner = await ownersRepo.create({
      email: demoEmail,
      passwordHash,
      role: "owner",
      status: "authenticated",
    });
  }

  for (const channel of CHANNEL_SEED) {
    const slugTaken = await postgres.query("SELECT 1 FROM channels WHERE slug = $1 LIMIT 1", [channel.slug]);
    if (slugTaken.rows.length > 0) continue;
    await postgres.query(
      `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), owner.id, channel.slug, channel.displayName, channel.tagline, channel.language, channel.agentId]
    );
  }

  for (const spec of DEMO_JOB_SEED) {
    const existingJob = await postgres.query("SELECT 1 FROM jobs WHERE idempotency_key = $1 LIMIT 1", [`demo-${spec.capability}-${spec.agentId}`]);
    if (existingJob.rows.length > 0) continue;
    await jobsRepo.create({
      agentId: spec.agentId,
      capability: spec.capability,
      idempotency_key: `demo-${spec.capability}-${spec.agentId}`,
      status: spec.status,
      owner_id: owner.id,
      payload: { demo: true, note: spec.note },
    });
  }

  const evidenceCount = await postgres.query("SELECT count(*) AS count FROM evidence_events");
  if (Number(evidenceCount.rows[0]?.count ?? 0) === 0) {
    await evidenceRepo.append({
      subjectId: "demo-bootstrap",
      kind: "system_demo_seed",
      classification: "labeled_demo_data",
      payload: { seededAt: new Date().toISOString(), storage: "demo" },
    });
  }
  return { seeded: true };
}

const AGENT_SEED = [
  { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" },
  { id: "agent-02", name: "SHERLOCK", namespace: "st.agent.sherlock" },
  { id: "agent-03", name: "LAKME", namespace: "st.agent.lakme" },
  { id: "agent-04", name: "PANCHI", namespace: "st.agent.panchi" },
  { id: "agent-05", name: "VEDA", namespace: "st.agent.veda" },
  { id: "agent-06", name: "BYTE", namespace: "st.agent.byte" },
  { id: "agent-07", name: "CHANAKYA", namespace: "st.agent.chanakya" },
  { id: "agent-08", name: "KABIR", namespace: "st.agent.kabir" },
  { id: "agent-09", name: "SHAKTI", namespace: "st.agent.shakti" },
  { id: "agent-10", name: "ROHAN", namespace: "st.agent.rohan" },
  { id: "agent-11", name: "MAYA", namespace: "st.agent.maya" },
  { id: "agent-12", name: "AAROHI", namespace: "st.agent.aarohi" },
  { id: "agent-13", name: "VIKRAM", namespace: "st.agent.vikram" },
  { id: "agent-14", name: "TARA", namespace: "st.agent.tara" },
  { id: "agent-15", name: "ANANYA", namespace: "st.agent.ananya" },
  { id: "agent-16", name: "KARAN", namespace: "st.agent.karan" },
  { id: "agent-17", name: "DEV", namespace: "st.agent.dev" },
  { id: "agent-18", name: "AANYA", namespace: "st.agent.aanya" },
  { id: "agent-19", name: "ARJUN", namespace: "st.agent.arjun" },
  { id: "agent-20", name: "NISHA", namespace: "st.agent.nisha" },
  { id: "agent-21", name: "NEWTON", namespace: "st.agent.newton" },
];

const CHANNEL_SEED = [
  { slug: "midnight-horror-hindi", displayName: "Midnight Horror Studios", tagline: "Connected horror cinematic universe — Hindi & Hinglish", language: "Hindi / Hinglish", agentId: "agent-01", launchTitle: "Nightfall Ward 7 — Pilot" },
  { slug: "mythology-epics", displayName: "Epic Mythology Labs", tagline: "Hindu mythology epics with narrator-led storytelling", language: "Hindi", agentId: "agent-03", launchTitle: "Samay Ke Paar — Season 1 Premiere" },
  { slug: "detective-anime", displayName: "Case Notes Anime", tagline: "Detective drama shorts, weekly cadence", language: "Hinglish", agentId: "agent-02", launchTitle: "The Alibi Engine — Case 001" },
  { slug: "science-explainers", displayName: "Newton Explains", tagline: "Science & engineering explainers for young viewers", language: "English", agentId: "agent-21", launchTitle: "Why Bridges Sing — Ep 1" },
];

const DEMO_JOB_SEED = [
  { agentId: "agent-01", capability: "story_plan", status: "queued", note: "Pilot episode story beats" },
  { agentId: "agent-01", capability: "visual_scene_plan", status: "running", note: "Scene planning for Nightfall Ward 7" },
  { agentId: "agent-03", capability: "narration_plan", status: "succeeded", note: "Narration pass complete" },
  { agentId: "agent-02", capability: "subtitle_plan", status: "failed", note: "Subtitle timing drift — needs owner retry" },
];

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: "100kb" }));

// ---------------------------------------------------------------------------
// Rate limiting (fixed: real client IP via trust proxy, bounded map, periodic sweep)
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE || "240", 10);
const AUTH_RATE_MAX = Number.parseInt(process.env.AUTH_RATE_LIMIT_PER_MINUTE || "10", 10);
const MAX_RATE_KEYS = 10_000;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.updatedAt < cutoff) rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function rateLimit(maxRequests) {
  return (req, res, next) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket = { count: 1, windowStart: now, updatedAt: now };
      rateBuckets.set(ip, bucket);
    } else {
      bucket.count += 1;
      bucket.updatedAt = now;
    }
    if (rateBuckets.size > MAX_RATE_KEYS) {
      rateBuckets.clear();
    }
    if (bucket.count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000));
      return res.status(429).json({ error: "TOO_MANY_REQUESTS_TRY_AGAIN_LATER" });
    }
    next();
  };
}

const generalLimiter = rateLimit(RATE_MAX);
const authLimiter = rateLimit(AUTH_RATE_MAX);
app.use("/api", generalLimiter);

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

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      cookies[part.slice(0, eqIdx).trim()] = decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return cookies;
}

async function authenticateOwner(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.slice(7).trim();
    }
    if (!token && req.headers.cookie) {
      token = parseCookies(req.headers.cookie).session_token ?? null;
    }
    if (!token) {
      return res.status(401).json({ error: "SESSION_TOKEN_REQUIRED" });
    }
    const session = await validateAndRetrieveSession(token);
    req.sessionToken = token;
    req.session = session;
    req.ownerId = session.ownerId;
    next();
  } catch (err) {
    const status = /EXPIRED|REVOCATION_EPOCH/.test(err.message) || ["INVALID_SESSION_TOKEN", "SESSION_REVOKED"].includes(err.message) ? 401 : 403;
    return res.status(status).json({ error: publicError(err, "AUTHENTICATION_FAILED") });
  }
}

async function requireCsrf(req, res, next) {
  const mutative = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
  if (!mutative) return next();
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  if (cookies.session_token && (!authHeader || !authHeader.toLowerCase().startsWith("bearer "))) {
    try {
      if (!req.session?.id) {
        return res.status(403).json({ error: "SESSION_ID_REQUIRED_FOR_CSRF" });
      }
      await verifyCsrfToken(req.session.id, req.headers["x-csrf-token"]);
    } catch (err) {
      return res.status(403).json({ error: publicError(err, "CSRF_REJECTED") });
    }
  }
  next();
}

function secureCookieHeader(name, value, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" || process.env.FORCE_SECURE_COOKIES === "1";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    service: "ST Production House Unified",
    status: storageMode === "unconfigured" ? "degraded" : "healthy",
    storage: storageMode,
    timestamp: new Date().toISOString(),
    dashboard: "/index.html",
    endpoints: {
      health: "/api/health",
      ready: "/api/ready",
      auth: "/api/auth/*",
      agents: "/api/agents",
      channels: "/api/channels",
      evidence: "/api/evidence",
      contentRuns: "/api/content-runs",
      control: "/api/control/*",
      metrics: "/api/metrics",
    },
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: storageMode === "unconfigured" ? "degraded" : "healthy",
    storage: storageMode,
    isDemoStorage: storageMode === "demo",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/ready", async (req, res) => {
  if (!postgres) {
    return res.status(503).json({ status: "not_ready", database: { status: "unconfigured" } });
  }
  try {
    await postgres.query("SELECT 1");
    return res.json({ status: "ready", database: { status: "healthy" }, storage: storageMode });
  } catch (error) {
    logInternalError("DATABASE_NOT_READY", error);
    return res.status(503).json({ status: "not_ready", database: { status: "unavailable" } });
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
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
  "DUPLICATE_AGENT_IDENTITY", "REQUEST_VALIDATION_FAILED", "OWNER_BOOTSTRAP_ALREADY_COMPLETED",
  "CHANNEL_NOT_FOUND", "PRODUCTION_VALIDATION_FAILED", "REGISTRATION_OPEN_ONLY_FOR_FIRST_OWNER",
  "CHANNEL_SLUG_EXISTS", "AGENT_DISABLED", "RELEASE_NOT_READY_FOR_PUBLISH", "PUBLISH_DESTINATION_REQUIRED",
  "PUBLIC_PUBLISHING_IDENTITY_REQUIRED", "RELEASE_NOT_FOUND", "RELEASE_ALREADY_PUBLISHED",
  "PRODUCTION_JOB_NOT_CLAIMABLE", "PRODUCTION_RUN_FAILED",
  "MESSAGE_VALIDATION_FAILED", "ROADMAP_VALIDATION_FAILED", "ROADMAP_ITEM_NOT_FOUND", "MEMORY_VALIDATION_FAILED",
]);

function safePayloadParse(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["email", "password"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "EMAIL_AND_PASSWORD_REQUIRED" });
    }
    if (storageMode === "unconfigured") {
      return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
    }
    // First owner bootstraps openly; afterwards registration is closed to
    // prevent public takeover of a single-owner production house.
    const count = await postgres.query("SELECT count(*)::integer AS count FROM owners");
    if (Number(count.rows[0]?.count ?? 0) > 0) {
      await recordAuditEvent(null, "registration_blocked_after_bootstrap", { attemptedEmail: normalizeEmail(email) });
      return res.status(403).json({ error: "OWNER_BOOTSTRAP_ALREADY_COMPLETED" });
    }
    const owner = await registerOwner(email, password, "owner");
    await recordAuditEvent(owner.id, "owner_registered", { email: owner.email });
    return res.status(201).json({ id: owner.id, email: owner.email, role: owner.role, status: owner.status, createdAt: owner.createdAt });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["email", "password"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "EMAIL_AND_PASSWORD_REQUIRED" });
    }
    const { owner, session } = await loginOwner(email, password);
    const csrfToken = await generateCsrfToken(session.session.id);
    res.setHeader("Set-Cookie", secureCookieHeader("session_token", session.token, 86400));
    return res.json({
      status: "success",
      owner: { id: owner.id, email: owner.email, role: owner.role, status: owner.status, mfaEnabled: owner.mfaEnabled },
      csrfToken,
      session: {
        id: session.session.id,
        mfaAssuranceLevel: session.session.mfaAssuranceLevel,
        absoluteExpiresAt: session.session.absoluteExpiresAt,
        idleExpiresAt: session.session.idleExpiresAt,
      },
    });
  } catch (err) {
    return res.status(401).json({ error: publicError(err, "INVALID_EMAIL_OR_PASSWORD") });
  }
});

app.post("/api/auth/logout", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    await logoutSession(req.sessionToken);
    res.setHeader("Set-Cookie", secureCookieHeader("session_token", "", 0));
    return res.json({ status: "success", message: "Successfully logged out" });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.get("/api/auth/me", authenticateOwner, async (req, res) => {
  try {
    const owner = await ownersRepo.findById(req.ownerId);
    if (!owner) return res.status(404).json({ error: "OWNER_NOT_FOUND" });
    return res.json({ id: owner.id, email: owner.email, role: owner.role, status: owner.status, mfaEnabled: owner.mfaEnabled });
  } catch (err) {
    logInternalError("OWNER_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/auth/sessions", authenticateOwner, async (req, res) => {
  try {
    const list = await sessionsRepo.listActive(req.ownerId);
    return res.json(list);
  } catch (err) {
    logInternalError("SESSION_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.delete("/api/auth/sessions/:id", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const revoked = await sessionsRepo.revoke(req.params.id, req.ownerId);
    if (!revoked) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    await recordAuditEvent(req.ownerId, "session_revoked_manually", { sessionId: req.params.id });
    return res.json({ status: "success", message: `Session ${req.params.id} revoked` });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.delete("/api/auth/sessions/other", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    await sessionsRepo.revokeAllOtherSessions(req.ownerId, req.session.id);
    await recordAuditEvent(req.ownerId, "other_sessions_revoked", {});
    return res.json({ status: "success", message: "All other sessions revoked successfully" });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.post("/api/auth/mfa/enroll", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    return res.json(await enrollTotpMfa(req.ownerId, req.sessionToken));
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.post("/api/auth/mfa/confirm", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const { enrollmentId, totpCode } = req.body;
    if (!enrollmentId || !totpCode) {
      return res.status(400).json({ error: "ENROLLMENT_ID_AND_TOTP_CODE_REQUIRED" });
    }
    return res.json(await confirmTotpMfa(req.ownerId, enrollmentId, totpCode));
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

app.post("/api/auth/mfa/verify", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const { totpCode } = req.body;
    if (!totpCode) return res.status(400).json({ error: "TOTP_CODE_REQUIRED" });
    const elevated = await verifyTotpAndElevateSession(req.ownerId, req.sessionToken, totpCode);
    res.setHeader("Set-Cookie", secureCookieHeader("session_token", elevated.token, 86400));
    return res.json({
      status: "success",
      session: {
        id: elevated.session.id,
        mfaAssuranceLevel: elevated.session.mfaAssuranceLevel,
        absoluteExpiresAt: elevated.session.absoluteExpiresAt,
        idleExpiresAt: elevated.session.idleExpiresAt,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
app.get("/api/agents", authenticateOwner, async (req, res) => {
  try {
    return res.json(await agentsRepo.list());
  } catch (err) {
    logInternalError("AGENT_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/agents/:id", authenticateOwner, async (req, res) => {
  try {
    const agent = await agentsRepo.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "AGENT_NOT_FOUND" });
    return res.json(agent);
  } catch (err) {
    logInternalError("AGENT_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.post("/api/agents", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["id", "name", "namespace", "enabled"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    await requireOwnerRole(req.ownerId, "owner");
    const { id, name, namespace, enabled } = req.body;
    if (!id || !name || !namespace) return res.status(400).json({ error: "AGENT_ID_NAME_AND_NAMESPACE_REQUIRED" });
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

// ---------------------------------------------------------------------------
// Channels & productions (multi-channel anime production house)
// ---------------------------------------------------------------------------
function getProductionRepository() {
  if (!postgres) throw new Error("STORAGE_NOT_CONFIGURED");
  return new ProductionRepository(postgres);
}

app.get("/api/channels", authenticateOwner, async (req, res) => {
  try {
    const channels = await getProductionRepository().listChannels(req.ownerId);
    return res.json({ count: channels.length, channels });
  } catch (err) {
    logInternalError("CHANNEL_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.post("/api/channels", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["slug", "displayName", "tagline", "language", "agentId"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { slug, displayName, tagline, language, agentId } = req.body;
    if (typeof slug !== "string" || !isValidChannelSlug(slug) ||
        typeof displayName !== "string" || displayName.trim().length < 2 || displayName.length > 120 ||
        (tagline !== undefined && tagline !== null && (typeof tagline !== "string" || tagline.length > 300)) ||
        (language !== undefined && (typeof language !== "string" || language.length > 60))) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const agent = await agentsRepo.get(agentId);
    if (!agent) return res.status(400).json({ error: "AGENT_NOT_FOUND" });
    const repo = getProductionRepository();
    if (await repo.channelSlugExists(req.ownerId, slug)) {
      return res.status(409).json({ error: "CHANNEL_SLUG_EXISTS" });
    }
    const channel = await repo.createChannel(req.ownerId, {
      slug, displayName: displayName.trim(), tagline: tagline ?? null, language, agentId,
    });
    await recordAuditEvent(req.ownerId, "channel_created", { channelId: channel.id, slug });
    return res.status(201).json(channel);
  } catch (err) {
    logInternalError("CHANNEL_CREATE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/channels/:id", authenticateOwner, async (req, res) => {
  try {
    const channel = await getProductionRepository().getChannel(req.ownerId, req.params.id);
    if (!channel) return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    const [releases, destinations] = await Promise.all([
      getProductionRepository().listReleasesForChannel(req.ownerId, req.params.id),
      getProductionRepository().listDestinations(req.ownerId, req.params.id),
    ]);
    // Public-facing fields only. The internal agent name stays server-side
    // (Rule 15): the dashboard uses agentId, never agentInternalName.
    return res.json({
      id: channel.id,
      slug: channel.slug,
      displayName: channel.displayName,
      tagline: channel.tagline,
      language: channel.language,
      agentId: channel.agentId,
      agentEnabled: channel.agentEnabled,
      releases,
      destinations,
    });
  } catch (err) {
    logInternalError("CHANNEL_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/productions", authenticateOwner, async (req, res) => {
  try {
    const productions = await getProductionRepository().listReleases(req.ownerId);
    return res.json({ count: productions.length, productions });
  } catch (err) {
    logInternalError("PRODUCTION_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.post("/api/productions", authenticateOwner, requireCsrf, async (req, releaseEpRes) => {
  try {
    if (!hasOnlyFields(req.body, ["channelId", "title", "season", "episode"])) {
      return releaseEpRes.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { channelId, title, season, episode } = req.body;
    if (typeof title !== "string" || title.trim().length < 1 || title.length > 200) {
      return releaseEpRes.status(400).json({ error: "PRODUCTION_VALIDATION_FAILED" });
    }
    const seasonNum = Number(season);
    const episodeNum = Number(episode);
    if (!Number.isSafeInteger(seasonNum) || seasonNum < 1 || seasonNum > 100 ||
        !Number.isSafeInteger(episodeNum) || episodeNum < 1 || episodeNum > 2000) {
      return releaseEpRes.status(400).json({ error: "PRODUCTION_VALIDATION_FAILED" });
    }
    const repo = getProductionRepository();
    const channel = await repo.getChannel(req.ownerId, channelId);
    if (!channel) return releaseEpRes.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    if (channel.agentEnabled === false) {
      return releaseEpRes.status(409).json({ error: "AGENT_DISABLED" });
    }

    const { release, jobId, conflict } = await repo.createReleaseWithJob(req.ownerId, {
      channelId, agentId: channel.agentId, title: title.trim(), season: seasonNum, episode: episodeNum,
    });
    if (conflict) return releaseEpRes.status(409).json({ error: "PRODUCTION_ALREADY_EXISTS" });

    await recordAuditEvent(req.ownerId, "production_queued", { releaseId: release.id, channelId, title });
    return releaseEpRes.status(201).json({ production: release, jobId });
  } catch (err) {
    logInternalError("PRODUCTION_CREATE_FAILED", err);
    return releaseEpRes.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/**
 * POST /api/productions/:id/run — owner-triggered synchronous pipeline run.
 *
 * Uses the job lifecycle's legal transitions (sql/010 + sql/017):
 * queued → leased → running → succeeded|failed. A background worker
 * (STPH_ENABLE_WORKERS=1) claims jobs the same legal way; when one is
 * running, concurrent runs fail closed because the job is no longer queued.
 * A failed run leaves the job `failed`, retryable via
 * /api/control/jobs/:id/retry (failed → queued is trigger-legal).
 */
app.post("/api/productions/:id/run", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    const repo = getProductionRepository();
    const release = await repo.getRelease(req.ownerId, req.params.id);
    if (!release) return res.status(404).json({ error: "NOT_FOUND" });
    if (release.status === "published") {
      return res.status(409).json({ error: "RELEASE_ALREADY_PUBLISHED" });
    }

    // Find the queued job for this release (owner-scoped, parameterized).
    const queuedJobs = await postgres.query(
      "SELECT id, payload FROM jobs WHERE owner_id = $1 AND capability = 'episode_production' ORDER BY created_at DESC LIMIT 200;",
      [req.ownerId]
    );
    const jobRow = queuedJobs.rows.find(
      (row) => row.payload?.releaseId === req.params.id || safePayloadParse(row.payload)?.releaseId === req.params.id
    );
    if (!jobRow) return res.status(404).json({ error: "NOT_FOUND" });

    // Trigger-legal claim: queued → leased → running (lease bounds the run).
    const leaseOwner = `api-run-${req.ownerId.slice(0, 8)}`;
    const leaseExpiresAt = new Date(Date.now() + 120_000);
    const claimed = await jobsRepo.claimLease(
      (await repo.getChannel(req.ownerId, release.channelId))?.agentId,
      "episode_production",
      leaseOwner,
      leaseExpiresAt
    );
    if (!claimed || claimed.id !== jobRow.id) {
      return res.status(409).json({ error: "PRODUCTION_JOB_NOT_CLAIMABLE" });
    }
    await jobsRepo.updateStatus(jobRow.id, "running");

    try {
      const result = await runEpisodePipeline({
        ownerId: req.ownerId,
        releaseId: req.params.id,
        production: repo,
        jobs: jobsRepo,
        evidenceLedger: evidenceRepo,
      });
      return res.json({ production: result.releaseId ? await repo.getRelease(req.ownerId, req.params.id) : null, artifacts: result.artifacts.length });
    } catch (pipelineError) {
      // Pipeline recorded the failure; job → failed (legal from running).
      await jobsRepo.updateStatus(jobRow.id, "failed").catch(() => {});
      logInternalError("PRODUCTION_RUN_FAILED", pipelineError);
      return res.status(500).json({ error: "PRODUCTION_RUN_FAILED" });
    }
  } catch (err) {
    logInternalError("PRODUCTION_RUN_ROUTE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/productions/:id", authenticateOwner, async (req, res) => {
  try {
    const repo = getProductionRepository();
    const release = await repo.getRelease(req.ownerId, req.params.id);
    if (!release) return res.status(404).json({ error: "NOT_FOUND" });
    const [events, artifacts] = await Promise.all([
      repo.listPipelineEvents(req.ownerId, req.params.id),
      repo.listArtifactsForRelease(req.ownerId, req.params.id),
    ]);
    return res.json({ release, events, artifacts });
  } catch (err) {
    logInternalError("PRODUCTION_LOOKUP_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/**
 * POST /api/productions/:id/publish (Rule 7 gate):
 * body { destinationId } — marks a ready release published to an owner-scoped
 * destination with non-empty public attribution. This records the publish
 * intent and evidence row; it does NOT contact any platform (live publishing
 * remains pending per Rules 11/16).
 */
app.post("/api/productions/:id/publish", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["destinationId"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const repo = getProductionRepository();
    const release = await repo.getRelease(req.ownerId, req.params.id);
    if (!release) return res.status(404).json({ error: "NOT_FOUND" });
    const destination = await repo.getDestination(req.ownerId, req.body.destinationId);
    const gate = evaluatePublishGate({ release, destination });
    if (!gate.ok) {
      return res.status(gate.code === "RELEASE_NOT_FOUND" ? 404 : 409).json({ error: gate.code });
    }
    const published = await repo.updateReleaseStatus(req.ownerId, req.params.id, "published");
    await repo.recordPipelineEvent({
      releaseId: req.params.id,
      ownerId: req.ownerId,
      stage: "complete",
      status: "succeeded",
      detail: { publishIntentRecorded: true, destinationId: destination.id, platform: destination.platform },
    });
    await evidenceRepo.append({
      subjectId: req.params.id,
      kind: "publish_intent_recorded",
      classification: "owner_authorized_publish_intent",
      payload: { destinationId: destination.id, platform: destination.platform },
    });
    await recordAuditEvent(req.ownerId, "production_publish_recorded", { releaseId: req.params.id, destinationId: destination.id });
    return res.json({ production: published, destination: { id: destination.id, platform: destination.platform, handle: destination.handle } });
  } catch (err) {
    logInternalError("PRODUCTION_PUBLISH_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// Publish destinations
// ---------------------------------------------------------------------------
app.get("/api/channels/:id/destinations", authenticateOwner, async (req, res) => {
  try {
    const destinations = await getProductionRepository().listDestinations(req.ownerId, req.params.id);
    return res.json({ count: destinations.length, destinations });
  } catch (err) {
    logInternalError("DESTINATION_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.post("/api/channels/:id/destinations", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["platform", "handle", "isPrimary", "publicAttribution"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const { platform, handle, isPrimary, publicAttribution } = req.body;
    if (!isKnownPlatform(platform) ||
        typeof handle !== "string" || handle.trim().length < 2 || handle.length > 120 ||
        typeof publicAttribution !== "string" || publicAttribution.trim().length < 2 || publicAttribution.length > 200) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const repo = getProductionRepository();
    const channel = await repo.getChannel(req.ownerId, req.params.id);
    if (!channel) return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    const destination = await repo.createDestination(req.ownerId, {
      channelId: req.params.id,
      platform,
      handle: handle.trim(),
      isPrimary: isPrimary === true,
      publicAttribution: publicAttribution.trim(),
    });
    await recordAuditEvent(req.ownerId, "destination_created", { channelId: req.params.id, destinationId: destination.id, platform });
    return res.status(201).json(destination);
  } catch (err) {
    logInternalError("DESTINATION_CREATE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// Director workspace (persistent communication window, roadmap, memory)
// ---------------------------------------------------------------------------

function getDirectorWorkspaceRepository() {
  if (!postgres) throw new Error("STORAGE_NOT_CONFIGURED");
  return new DirectorWorkspaceRepository(postgres);
}

/** Resolves :agentId to an existing agent; returns the agent or sends 404. */
async function resolveAgentOr404(req, res, agentId) {
  const agent = await agentsRepo.get(agentId);
  if (!agent) {
    res.status(404).json({ error: "AGENT_NOT_FOUND" });
    return null;
  }
  return agent;
}

/**
 * GET /api/directors/:agentId/conversation — the persistent communication
 * window (lazily created; Director #50 gets the same window as #01).
 */
app.get("/api/directors/:agentId/conversation", authenticateOwner, async (req, res) => {
  try {
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const repo = getDirectorWorkspaceRepository();
    const conversation = await repo.getOrCreateConversation(req.ownerId, req.params.agentId);
    const messages = await repo.listMessages(req.ownerId, req.params.agentId);
    return res.json({ conversation, messages });
  } catch (err) {
    logInternalError("DIRECTOR_CONVERSATION_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/**
 * POST /api/directors/:agentId/conversation — append a message with explicit
 * execution semantics (conversation | proposal | instruction | decision).
 * Recording NEVER triggers production or publishing: conversation is not
 * execution (Blueprint §10). Decisions are evidence, not side effects.
 */
app.post("/api/directors/:agentId/conversation", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["sender", "kind", "body"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const repo = getDirectorWorkspaceRepository();
    const message = await repo.appendMessage(req.ownerId, req.params.agentId, req.body);
    await recordAuditEvent(req.ownerId, "director_message_recorded", {
      agentId: req.params.agentId,
      messageId: message.id,
      kind: message.kind,
      sender: message.sender,
    });
    return res.status(201).json(message);
  } catch (err) {
    if (err.message === "MESSAGE_VALIDATION_FAILED") {
      return res.status(400).json({ error: "MESSAGE_VALIDATION_FAILED" });
    }
    logInternalError("DIRECTOR_MESSAGE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/** GET /api/directors/:agentId/roadmap — long-term roadmap, optional ?bucket=. */
app.get("/api/directors/:agentId/roadmap", authenticateOwner, async (req, res) => {
  try {
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const bucket = req.query.bucket === undefined ? null : String(req.query.bucket);
    const items = await getDirectorWorkspaceRepository().listRoadmap(req.ownerId, req.params.agentId, { bucket });
    return res.json({ count: items.length, items });
  } catch (err) {
    if (err.message === "ROADMAP_VALIDATION_FAILED") {
      return res.status(400).json({ error: "ROADMAP_VALIDATION_FAILED" });
    }
    logInternalError("DIRECTOR_ROADMAP_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/** POST /api/directors/:agentId/roadmap — add a roadmap item to a bucket. */
app.post("/api/directors/:agentId/roadmap", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["bucket", "title", "detail"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const item = await getDirectorWorkspaceRepository().addRoadmapItem(req.ownerId, req.params.agentId, req.body);
    await recordAuditEvent(req.ownerId, "director_roadmap_item_added", {
      agentId: req.params.agentId,
      itemId: item.id,
      bucket: item.bucket,
    });
    return res.status(201).json(item);
  } catch (err) {
    if (err.message === "ROADMAP_VALIDATION_FAILED") {
      return res.status(400).json({ error: "ROADMAP_VALIDATION_FAILED" });
    }
    logInternalError("DIRECTOR_ROADMAP_ADD_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/** PATCH /api/directors/roadmap/:itemId — move an item through its lifecycle. */
app.patch("/api/directors/roadmap/:itemId", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["status"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const updated = await getDirectorWorkspaceRepository().updateRoadmapItemStatus(req.ownerId, req.params.itemId, req.body.status);
    if (!updated) return res.status(404).json({ error: "ROADMAP_ITEM_NOT_FOUND" });
    await recordAuditEvent(req.ownerId, "director_roadmap_item_updated", {
      itemId: req.params.itemId,
      status: updated.status,
    });
    return res.json(updated);
  } catch (err) {
    if (err.message === "ROADMAP_VALIDATION_FAILED") {
      return res.status(400).json({ error: "ROADMAP_VALIDATION_FAILED" });
    }
    logInternalError("DIRECTOR_ROADMAP_UPDATE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/** GET /api/directors/:agentId/memory — isolated memory for one director. */
app.get("/api/directors/:agentId/memory", authenticateOwner, async (req, res) => {
  try {
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const entries = await getDirectorWorkspaceRepository().listMemory(req.ownerId, req.params.agentId);
    return res.json({ count: entries.length, entries });
  } catch (err) {
    logInternalError("DIRECTOR_MEMORY_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

/** PUT /api/directors/:agentId/memory/:category — upsert one memory category. */
app.put("/api/directors/:agentId/memory/:category", authenticateOwner, requireCsrf, async (req, res) => {
  try {
    if (!hasOnlyFields(req.body, ["content"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    if (!(await resolveAgentOr404(req, res, req.params.agentId))) return;
    const entry = await getDirectorWorkspaceRepository().saveMemory(req.ownerId, req.params.agentId, {
      category: req.params.category,
      content: req.body.content,
    });
    await recordAuditEvent(req.ownerId, "director_memory_saved", {
      agentId: req.params.agentId,
      category: entry.category,
    });
    return res.json(entry);
  } catch (err) {
    if (err.message === "MEMORY_VALIDATION_FAILED") {
      return res.status(400).json({ error: "MEMORY_VALIDATION_FAILED" });
    }
    logInternalError("DIRECTOR_MEMORY_SAVE_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// Evidence & audit
// ---------------------------------------------------------------------------
app.get("/api/evidence", authenticateOwner, async (req, res) => {
  try {
    return res.json(await evidenceRepo.list());
  } catch (err) {
    logInternalError("EVIDENCE_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

app.get("/api/audit", authenticateOwner, async (req, res) => {
  try {
    return res.json(await listAuditEvents());
  } catch (err) {
    logInternalError("AUDIT_LIST_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// Metrics (monitoring hook — Prometheus/Grafana scrape target)
// ---------------------------------------------------------------------------
app.get("/api/metrics", authenticateOwner, async (req, res) => {
  try {
    const [agents, jobs, evidence, sessions, channels] = await Promise.all([
      postgres.query("SELECT count(*)::integer AS count FROM agents"),
      postgres.query("SELECT status, count(*)::integer AS count FROM jobs GROUP BY status"),
      postgres.query("SELECT count(*)::integer AS count FROM evidence_events"),
      postgres.query("SELECT count(*)::integer AS count FROM owner_sessions WHERE revoked_at IS NULL"),
      postgres.query("SELECT count(*)::integer AS count FROM channels WHERE owner_id = $1", [req.ownerId]),
    ]);
    const jobsByStatus = {};
    for (const row of jobs.rows) jobsByStatus[row.status] = Number(row.count);
    return res.json({
      timestamp: new Date().toISOString(),
      storage: storageMode,
      agents: Number(agents.rows[0]?.count ?? 0),
      jobsByStatus,
      evidenceEvents: Number(evidence.rows[0]?.count ?? 0),
      activeSessions: Number(sessions.rows[0]?.count ?? 0),
      channels: Number(channels.rows[0]?.count ?? 0),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        nodeVersion: process.version,
      },
    });
  } catch (err) {
    logInternalError("METRICS_FAILED", err);
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }
});

// ---------------------------------------------------------------------------
// Owner dashboard routers (content runs + control mutations)
// ---------------------------------------------------------------------------
app.use("/api/content-runs", authenticateOwner, createContentRunsRouter({
  packageRunStore: {
    async listRuns(ownerId) {
      const rows = await postgres.query("SELECT * FROM jobs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100", [ownerId]);
      return rows.rows.map((row) => ({
        packageTaskId: row.id,
        orchestrator: "job_queue",
        agentId: row.agent_id,
        ownerId: row.owner_id,
        readiness: row.status === "succeeded" ? "ready" : "pending",
        reasonCode: null,
        stagesCompleted: [],
        publication: { requested: false, status: null },
        provenance: { generationMode: "queue", providerCalls: Number(row.attempts ?? 0), networkCalls: 0, generatedMediaCount: 0, mediaStatus: null },
      }));
    },
    async getRun(ownerId, packageTaskId) {
      const rows = await postgres.query("SELECT * FROM jobs WHERE id = $1 AND owner_id = $2", [packageTaskId, ownerId]);
      if (rows.rows.length === 0) return null;
      const row = rows.rows[0];
      return {
        packageTaskId: row.id,
        orchestrator: "job_queue",
        agentId: row.agent_id,
        ownerId: row.owner_id,
        readiness: row.status === "succeeded" ? "ready" : "pending",
        reasonCode: null,
        stages: [{ stage: "job", status: row.status, taskId: row.id, jobType: row.capability }],
        plans: {},
        stagesCompleted: [],
        publication: { requested: false, status: null },
        provenance: { generationMode: "queue", providerCalls: Number(row.attempts ?? 0), networkCalls: 0, generatedMediaCount: 0, mediaStatus: null },
      };
    },
  },
  evidenceLedger: {
    list: () => evidenceRepo.list(),
  },
}));

const control = createOwnerControlRouter({
  sessions: new Map(),
  jobControlStore: null,
  evidenceLedger: null,
  resilienceRepository: null,
  dbAdapter: postgres,
});
app.use("/api/control", authenticateOwner, control);

// ---------------------------------------------------------------------------
// Secrets & Connections (Issue #164): provider catalog + per-director
// connections. Owner routes: authenticated session, CSRF on mutations,
// server-authoritative scoping, audit events, safe DTOs (Rules 5/6/15/17).
// ---------------------------------------------------------------------------
app.use("/api/providers", authenticateOwner, createProviderCatalogRouter());
app.use("/api/connections", authenticateOwner, createDirectorConnectionsRouter({
  db: () => postgres,
  recordAuditEvent,
}));

// ---------------------------------------------------------------------------
// Static dashboard + SPA fallback
// ---------------------------------------------------------------------------
const dashboardRouter = express.Router();
const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
dashboardRouter.use(express.static(publicDir, { index: "index.html", maxAge: "1h", setHeaders: (res, path) => { if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); } }));
dashboardRouter.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
app.use(dashboardRouter);

// 404 for unknown API routes (never leak route inventory publicly)
app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

// Error handling middleware: no stack traces or secrets
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return res.status(err.status === 413 ? 413 : 400).json({ error: "REQUEST_BODY_INVALID" });
  }
  logInternalError("UNHANDLED_API_ERROR", err);
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

/** Graceful shutdown helper for tests and the entrypoint. */
export async function closeRuntime() {
  try {
    if (productionWorker) productionWorker.stop();
  } catch {
    // already stopped
  }
  try {
    if (postgres && typeof postgres.closePool === "function") {
      await postgres.closePool();
    }
  } catch {
    // already closed
  }
}

export default app;
