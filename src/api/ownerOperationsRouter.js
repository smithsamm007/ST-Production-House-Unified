/**
 * ST Production House — Owner live-operations routes (Issue #192).
 *
 * Wires the PR #191 services into the owner API so the owner can actually
 * operate them:
 *   - configured-provider smoke test       (src/providers/providerSmokeTest.js)
 *   - private-first publishing test        (src/publishing/privatePublishingTest.js)
 *   - server-sourced analytics collection (src/analytics/analyticsService.js)
 *
 * Routes (mounted at `/ops` behind requireAuth in ownerServer.js)
 * ---------------------------------------------------------------
 *   POST /ops/providers/:agentId/smoke-test    → provider smoke test
 *   POST /ops/publishing/:agentId/private-test → private-first publish test
 *   POST /ops/analytics/ingest                 → collect and record platform metrics
 *   GET  /ops/analytics                        → owner-scoped analytics records
 *
 * Security contract (AGENTS.md Rules 1–3, 6, 15, 17):
 * - Every mutation requires a valid session (requireAuth, mounted outside)
 *   AND a per-session CSRF token via the `x-csrf-token` header (same
 *   mechanism as the S-M18-02 control router).
 * - Identity is server-authoritative: the session's ownerId scopes every
 *   request. Client-supplied owner fields are rejected (SCOPE_MISMATCH).
 * - Provider slots and publishing transports are SERVER-SIDE options only.
 *   The request body can never select a transport, a credential, or a slot
 *   layout — that would be client-driven provider execution.
 * - The smoke-test executor transport is the ONLY credential-bearing input
 *   and it lives server-side; the broker delivers secrets straight to the
 *   transport (locators never serialize — Rule 17).
 * - Unconfigured transports degrade honestly: 503 with a stable code, never
 *   a fabricated success (Rules 1–3).
 * - Responses use strict field allowlists (Rule 17). Error bodies use the
 *   fixed public error-code allowlist; Rule 15/17 leakage denials from the
 *   services surface as clean 4xx (422), never as leaked internals.
 * - Every mutation writes an owner_control_audit row (Rule 6) using the
 *   actions widened additively by sql/026.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import { deepRedactAndSanitize } from "../jobs/retry/retryManager.js";
import {
  runProviderSmokeTest,
  ProviderSmokeTestError,
} from "../providers/providerSmokeTest.js";
import {
  PrivatePublishingTestService,
  PrivatePublishingTestError,
} from "../publishing/privatePublishingTest.js";
import {
  AnalyticsService,
  AnalyticsServiceError,
} from "../analytics/analyticsService.js";
import { PostgresAnalyticsRepository } from "../analytics/postgresAnalyticsRepository.js";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/;
const OWNER_ID_RE = /^[a-zA-Z0-9_-]{3,80}$/;
const PLATFORMS = new Set(["youtube", "instagram", "facebook", "snapchat"]);
const ANALYTICS_METRIC_FIELDS = Object.freeze([
  "views",
  "watchTimeSeconds",
  "likes",
  "shares",
  "commentsCount",
  "impressions",
]);
const MAX_CAPTION_BYTES = 4096;
const MAX_METADATA_BYTES = 2048;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Small helpers (mirrors ownerControlRouter.js conventions)
// ---------------------------------------------------------------------------

function fail(code, status) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status ?? 400;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(code);
  }
}

function requireString(value, code, { max, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0) throw fail(code);
  if (max !== undefined && value.length > max) throw fail(code);
  if (pattern && !pattern.test(value)) throw fail(code);
  return value;
}

function requireHttpsUrl(value, code, { max = 512 } = {}) {
  const raw = requireString(value, code, { max });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(code);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw fail(code);
  }
  return raw;
}

function boundedJson(value, code, maxBytes) {
  if (value === null || value === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw fail(code);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw fail(code);
  }
  return value;
}

function requireCsrf(req, sessions) {
  const tokenHash = createHash("sha256")
    .update(String(req.headers.authorization || "").substring(7).trim())
    .digest("hex");
  const session = sessions.get(tokenHash);
  const provided = req.headers["x-csrf-token"];
  if (
    !session ||
    typeof session.csrfTokenHash !== "string" ||
    typeof provided !== "string" ||
    provided.length < 16 ||
    provided.length > 128 ||
    createHash("sha256").update(provided).digest("hex") !== session.csrfTokenHash
  ) {
    throw fail("CSRF_TOKEN_INVALID", 403);
  }
}

// ---------------------------------------------------------------------------
// Safe DTO projections (Rule 17): explicit field allowlists only.
// ---------------------------------------------------------------------------

function smokeTestDto(result) {
  return {
    smokeTestId: result.smokeTestId,
    agentId: result.agentId,
    taskId: result.taskId,
    status: result.status,
    selectedProvider: result.selectedProvider,
    selectedSlot: result.selectedSlot,
    // Receipt: opaque provider evidence fields only — never raw provider
    // payloads, never credential material.
    receipt: {
      providerResponseId: result.receipt?.providerResponseId ?? null,
      providerResponseSha256: result.receipt?.providerResponseSha256 ?? null,
      artifactSha256: result.receipt?.artifactSha256 ?? null,
    },
    attempts: (result.attempts ?? []).map((attempt) => ({
      slot: attempt.slot,
      provider: attempt.provider,
      kind: attempt.kind ?? null,
      outcome: attempt.outcome,
      errorCode: attempt.errorCode ?? null,
    })),
  };
}

function publishingTestDto(result) {
  return {
    testId: result.testId,
    requestId: result.requestId,
    agentId: result.agentId,
    destination: result.destination,
    mode: result.mode,
    status: result.status,
    published: result.published === true,
    platformPostId: result.platformPostId ?? null,
    platformUrl: result.platformUrl ?? null,
    providerResponseSha256: result.providerResponseSha256 ?? null,
    publicAttribution: result.publicAttribution ?? null,
  };
}

function analyticsRecordDto(record) {
  return {
    recordId: record.recordId,
    ownerId: record.ownerId,
    platformPostId: record.platformPostId,
    platformUrl: record.platformUrl,
    platform: record.platform,
    metrics: {
      views: record.metrics?.views ?? 0,
      watchTimeSeconds: record.metrics?.watchTimeSeconds ?? 0,
      likes: record.metrics?.likes ?? 0,
      shares: record.metrics?.shares ?? 0,
      commentsCount: record.metrics?.commentsCount ?? 0,
      impressions: record.metrics?.impressions ?? 0,
    },
    collectedAt: record.collectedAt,
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOwnerOperationsRouter(options = {}) {
  const router = Router();

  const sessions = options.sessions; // shared with ownerServer (requireAuth)
  const dbAdapter = options.dbAdapter; // owner_control_audit inserts
  const evidenceLedger = options.evidenceLedger ?? null;
  const smokeTransport = options.providerSmokeTransport ?? null;
  const publishingPublisher = options.publishingPublisher ?? null;
  const analyticsTransport = options.analyticsTransport ?? null;
  // Durable analytics (Issue #194): when a database adapter is available,
  // analytics records persist in PostgreSQL (sql/027) through the durable
  // repository. Without one, the service's labeled in-memory DEMO transport
  // applies — visibly non-durable, never claimed as durable.
  const analyticsStorage = options.analyticsStorage ?? (dbAdapter && typeof dbAdapter.query === "function"
    ? new PostgresAnalyticsRepository(dbAdapter)
    : null);
  const analyticsService = options.analyticsService ?? new AnalyticsService({ evidenceLedger, storage: analyticsStorage });
  const hasLedger = evidenceLedger !== null && evidenceLedger !== undefined;

  if (!sessions || typeof sessions.get !== "function") {
    throw new Error("OWNER_OPERATIONS_SESSIONS_REQUIRED");
  }

  function guarded(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : null;
        const status = typeof error?.httpStatus === "number" ? error.httpStatus : 500;
        const safeMessage = deepRedactAndSanitize(String(error?.message ?? "INTERNAL_SERVER_ERROR"));
        if (code && status !== 500) {
          res.status(status).json({ error: code });
        } else {
          res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
        }
        if (process.env.STPH_CONTROL_DEBUG === "1") {
          console.error(`[ownerOperations] ${code ?? "UNHANDLED"}: ${safeMessage}`);
        }
      }
    };
  }

  function ownerIdOf(req) {
    const ownerId = req.session?.ownerId;
    if (typeof ownerId !== "string" || !OWNER_ID_RE.test(ownerId)) {
      throw fail("UNAUTHORIZED", 401);
    }
    return ownerId;
  }

  function requireAgentId(req) {
    const raw = req.params?.agentId;
    if (typeof raw !== "string" || !AGENT_ID_RE.test(raw)) throw fail("AGENT_ID_INVALID");
    return raw;
  }

  function requireDb() {
    if (!dbAdapter || typeof dbAdapter.query !== "function") {
      throw fail("DATABASE_ADAPTER_UNAVAILABLE", 503);
    }
  }

  async function recordAudit({ ownerId, agentId, action, detail }) {
    requireDb();
    await dbAdapter.query(
      `INSERT INTO owner_control_audit (owner_id, agent_id, job_id, action, from_status, to_status, detail)
       VALUES ($1, $2, NULL, $3, NULL, NULL, $4)`,
      [ownerId, agentId, action, JSON.stringify(detail ?? {})]
    );
  }

  /** Map service-domain errors onto the public allowlist, fail-closed. */
  function mapServiceError(error, fallbackCode) {
    const code = error?.code;
    if (
      code === "AGENT_NAME_LEAKAGE_DENIED" ||
      code === "SECRET_LEAKAGE_DENIED"
    ) {
      // Rule 15/17 violation attempt: clean 422, no echo of the offending
      // material.
      throw fail(code, 422);
    }
    if (error instanceof ProviderSmokeTestError || error instanceof PrivatePublishingTestError || error instanceof AnalyticsServiceError) {
      throw fail(code ?? fallbackCode, 422);
    }
    throw fail(fallbackCode, 500);
  }

  /** Storage unavailability degrades honestly (503), never a fake write. */
  function mapStorageError(error) {
    if (error?.code === "ANALYTICS_STORAGE_NOT_CONFIGURED") {
      throw fail("ANALYTICS_STORAGE_NOT_CONFIGURED", 503);
    }
  }

  function parseLimit(raw) {
    if (raw === undefined || raw === null || raw === "") return 50;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw fail("QUERY_INVALID");
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // POST /providers/:agentId/smoke-test — configured-provider smoke test
  // -------------------------------------------------------------------------
  router.post(
    "/providers/:agentId/smoke-test",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      const agentId = requireAgentId(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");
      if (req.body.ownerId !== undefined && req.body.ownerId !== ownerId) {
        throw fail("SCOPE_MISMATCH", 403);
      }
      // Client input can NEVER carry slots, credential refs, or the
      // transport: those are server-side configuration only.
      if (
        req.body.slots !== undefined ||
        req.body.executor !== undefined ||
        req.body.transport !== undefined ||
        req.body.credentialRef !== undefined
      ) {
        throw fail("CLIENT_TRANSPORT_FORBIDDEN", 400);
      }
      const taskId = req.body.taskId === undefined
        ? undefined
        : requireString(req.body.taskId, "TASK_ID_INVALID", { max: 120 });

      // Transport must be configured server-side; otherwise degrade
      // honestly (503) — never a fabricated run. The transport contract is
      // an object: getTaskProviderSlots({ ownerId, agentId }) resolving the
      // owner's configured 4-slot policy, plus execute(args) as the
      // credential-bearing executor the broker delivers secrets to.
      if (
        !smokeTransport ||
        typeof smokeTransport.getTaskProviderSlots !== "function" ||
        typeof smokeTransport.execute !== "function"
      ) {
        throw fail("PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE", 503);
      }
      // The owner's configured provider slots come from server-side
      // configuration (per-Director Secrets & Connections), addressed by
      // the (owner, agent) scope. The transport resolves them; the router
      // never accepts slot material from the request.
      let slots;
      try {
        slots = await smokeTransport.getTaskProviderSlots({ ownerId, agentId });
      } catch {
        // Transport resolution failures degrade honestly (503) — never a
        // fabricated run and never a leaked transport error.
        throw fail("PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE", 503);
      }
      if (!Array.isArray(slots)) {
        throw fail("PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE", 503);
      }

      let result;
      try {
        result = await runProviderSmokeTest({
          ownerId,
          agentId,
          ...(taskId !== undefined ? { taskId } : {}),
          slots,
          executor: (executorArgs) => smokeTransport.execute(executorArgs),
          evidenceLedger: hasLedger ? evidenceLedger : null,
        });
      } catch (error) {
        mapServiceError(error, "PROVIDER_SMOKE_TEST_FAILED");
      }

      await recordAudit({
        ownerId,
        agentId,
        action: "provider_smoke_test",
        detail: {
          smokeTestId: result.smokeTestId,
          taskId: result.taskId,
          selectedProvider: result.selectedProvider,
          selectedSlot: result.selectedSlot,
          attemptCount: (result.attempts ?? []).length,
        },
      });
      if (hasLedger) {
        evidenceLedger.append({
          subjectId: result.smokeTestId,
          kind: "owner_provider_smoke_test",
          classification: "owner_authorized_provider_operation",
          payload: {
            ownerId,
            agentId,
            taskId: result.taskId,
            selectedProvider: result.selectedProvider,
          },
        });
      }

      res.status(200).json({ smokeTest: smokeTestDto(result) });
    })
  );

  // -------------------------------------------------------------------------
  // POST /publishing/:agentId/private-test — private-first publishing test
  // -------------------------------------------------------------------------
  router.post(
    "/publishing/:agentId/private-test",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      const agentId = requireAgentId(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");
      if (req.body.ownerId !== undefined && req.body.ownerId !== ownerId) {
        throw fail("SCOPE_MISMATCH", 403);
      }
      if (req.body.publisher !== undefined || req.body.publishingService !== undefined) {
        throw fail("CLIENT_TRANSPORT_FORBIDDEN", 400);
      }
      const artifactSha256 = requireString(req.body.artifactSha256, "VERIFIED_ARTIFACT_REQUIRED", {
        max: 64,
        pattern: /^[a-f0-9]{64}$/,
      });
      const destination = requireString(req.body.destination, "INVALID_PLATFORM_DESTINATION", { max: 20 });
      if (!PLATFORMS.has(destination.toLowerCase())) {
        throw fail("INVALID_PLATFORM_DESTINATION");
      }
      const mode = req.body.mode === undefined ? "private" : requireString(req.body.mode, "PRIVATE_FIRST_MODE_REQUIRED", { max: 10 });
      if (mode !== "private" && mode !== "draft") {
        throw fail("PRIVATE_FIRST_MODE_REQUIRED");
      }
      const captionSnapshot = boundedJson(req.body.captionSnapshot, "CAPTION_SNAPSHOT_INVALID", MAX_CAPTION_BYTES);
      if (captionSnapshot === undefined) throw fail("CAPTION_SNAPSHOT_INVALID");
      if (req.body.affiliateLinkIds !== undefined) {
        if (!Array.isArray(req.body.affiliateLinkIds) || req.body.affiliateLinkIds.length > 20) {
          throw fail("AFFILIATE_LINKS_INVALID");
        }
        for (const id of req.body.affiliateLinkIds) {
          if (typeof id !== "string" || id.length === 0 || id.length > 160) {
            throw fail("AFFILIATE_LINKS_INVALID");
          }
        }
      }
      const approvalExpiresInMs = req.body.approvalExpiresInMs === undefined
        ? 300000
        : Number(req.body.approvalExpiresInMs);
      if (!Number.isSafeInteger(approvalExpiresInMs) || approvalExpiresInMs < 1000 || approvalExpiresInMs > 3600000) {
        throw fail("APPROVAL_WINDOW_INVALID");
      }

      if (!publishingPublisher || typeof publishingPublisher.publish !== "function") {
        throw fail("PUBLISHING_TRANSPORT_UNAVAILABLE", 503);
      }

      const service = new PrivatePublishingTestService({
        publishingService: options.publishingService ?? undefined,
        evidenceLedger: hasLedger ? evidenceLedger : null,
      });

      // Public identity (brand/attribution) is resolved SERVER-SIDE from
      // the owner's configured digital identity for this agent — the
      // request body can never supply it (it would be an unverified
      // attribution claim).
      const identity = typeof options.resolvePublishingIdentity === "function"
        ? await options.resolvePublishingIdentity({ ownerId, agentId, destination })
        : null;
      if (!identity || identity.agentId !== agentId) {
        throw fail("PUBLIC_PUBLISHING_IDENTITY_REQUIRED", 422);
      }

      let result;
      try {
        result = await service.runPrivatePublishingTest({
          ownerId,
          agentId,
          agent: identity.agent,
          profile: identity.profile,
          primarySocialAccount: identity.primarySocialAccount ?? undefined,
          artifactSha256,
          destination,
          captionSnapshot,
          affiliateLinkIds: Array.isArray(req.body.affiliateLinkIds) ? req.body.affiliateLinkIds : [],
          mode,
          approvalExpiresInMs,
          publisher: publishingPublisher,
        });
      } catch (error) {
        mapServiceError(error, "PRIVATE_PUBLISHING_TEST_FAILED");
      }

      await recordAudit({
        ownerId,
        agentId,
        action: "private_publishing_test",
        detail: {
          testId: result.testId,
          requestId: result.requestId,
          destination,
          mode,
          platformPostId: result.platformPostId,
        },
      });
      if (hasLedger) {
        evidenceLedger.append({
          subjectId: result.testId,
          kind: "owner_private_publishing_test",
          classification: "owner_authorized_private_first",
          payload: {
            ownerId,
            agentId,
            destination,
            mode,
            platformPostId: result.platformPostId,
          },
        });
      }

      res.status(200).json({ publishingTest: publishingTestDto(result) });
    })
  );

  // -------------------------------------------------------------------------
  // POST /analytics/ingest — record genuine platform analytics (no invented
  // metrics: the service validates every field; non-numeric or negative
  // values are rejected).
  // -------------------------------------------------------------------------
  router.post(
    "/analytics/ingest",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");
      if (req.body.ownerId !== undefined && req.body.ownerId !== ownerId) {
        throw fail("SCOPE_MISMATCH", 403);
      }
      const platformPostId = requireString(req.body.platformPostId, "PLATFORM_POST_ID_REQUIRED", { max: 200 });
      if (Object.keys(req.body).some((key) => !["ownerId", "platformPostId"].includes(key))) {
        throw fail("CLIENT_TRANSPORT_FORBIDDEN", 400);
      }

      if (!analyticsTransport || typeof analyticsTransport.fetchSnapshot !== "function") {
        throw fail("ANALYTICS_TRANSPORT_UNAVAILABLE", 503);
      }
      let snapshot;
      try {
        snapshot = await analyticsTransport.fetchSnapshot({ ownerId, platformPostId });
      } catch {
        throw fail("ANALYTICS_TRANSPORT_UNAVAILABLE", 503);
      }
      if (
        !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        snapshot.platformPostId !== platformPostId
      ) {
        throw fail("ANALYTICS_TRANSPORT_UNAVAILABLE", 503);
      }
      let platformUrl;
      let platform;
      let metrics;
      let metadata;
      try {
        platformUrl = requireHttpsUrl(snapshot.platformUrl, "INVALID_PLATFORM_URL");
        platform = requireString(snapshot.platform, "INVALID_PLATFORM", { max: 20 });
        if (!PLATFORMS.has(platform.toLowerCase())) throw new Error("INVALID_PLATFORM");
        requirePlainObject(snapshot.metrics, "INVALID_ANALYTICS_METRICS");
        const metricFields = Object.keys(snapshot.metrics);
        if (
          metricFields.length !== ANALYTICS_METRIC_FIELDS.length ||
          ANALYTICS_METRIC_FIELDS.some((field) =>
            !Object.hasOwn(snapshot.metrics, field) ||
            typeof snapshot.metrics[field] !== "number" ||
            !Number.isSafeInteger(snapshot.metrics[field]) ||
            snapshot.metrics[field] < 0
          )
        ) {
          throw new Error("INVALID_ANALYTICS_METRICS");
        }
        metrics = snapshot.metrics;
        metadata = snapshot.metadata ?? {};
        requirePlainObject(metadata, "INVALID_ANALYTICS_METADATA");
        boundedJson(metadata, "INVALID_ANALYTICS_METADATA", MAX_METADATA_BYTES);
      } catch {
        throw fail("ANALYTICS_TRANSPORT_UNAVAILABLE", 503);
      }

      let record;
      try {
        record = await analyticsService.ingestAnalytics({
          ownerId,
          agentId: snapshot.agentId ?? null,
          platformPostId: snapshot.platformPostId,
          platformUrl,
          platform,
          metrics,
          metadata,
        });
      } catch (error) {
        mapStorageError(error);
        mapServiceError(error, "ANALYTICS_INGEST_FAILED");
      }

      await recordAudit({
        ownerId,
        agentId: null,
        action: "analytics_ingest",
        detail: {
          recordId: record.recordId,
          platformPostId,
          platform: record.platform,
        },
      });

      res.status(201).json({ record: analyticsRecordDto(record) });
    })
  );

  // -------------------------------------------------------------------------
  // GET /analytics — owner-scoped analytics records (read-only)
  // -------------------------------------------------------------------------
  router.get(
    "/analytics",
    guarded(async (req, res) => {
      const ownerId = ownerIdOf(req);
      const limit = parseLimit(req.query?.limit);
      if (!analyticsService || typeof analyticsService.listByOwner !== "function") {
        throw fail("ANALYTICS_SERVICE_UNAVAILABLE", 503);
      }
      let rows;
      try {
        rows = await analyticsService.listByOwner(ownerId, { limit });
      } catch (error) {
        mapStorageError(error);
        mapServiceError(error, "ANALYTICS_LIST_FAILED");
      }
      const records = (rows ?? []).map(analyticsRecordDto);
      res.status(200).json({ ownerId, count: records.length, records });
    })
  );

  return router;
}

export default createOwnerOperationsRouter;
