/**
 * ST Production House — Owner API: content package runs & evidence timeline.
 *
 * Backlog slice S-M18-01 (Module 18, owner-dashboard surface part 1).
 * Authenticated, owner-scoped READ routes exposing:
 *
 *   GET /content-runs                       → content package runs for the session owner
 *   GET /content-runs/:packageTaskId        → one run (safe DTO projection)
 *   GET /content-runs/:packageTaskId/evidence
 *                                           → evidence events with recomputed
 *                                             hash-chain positions and integrity
 *
 * Security contract (AGENTS.md Rules 6, 15, 17):
 * - Every route requires a valid authenticated session (mounted behind
 *   requireAuth); the queried owner is ALWAYS the server-side session owner,
 *   never client input.
 * - Cross-owner access fails closed as a generic 404 (no existence leak).
 * - Outbound serialization uses EXPLICIT field allowlists: unknown fields,
 *   secrets, and locators are never serialized (Rule 17).
 * - Malformed requests yield clean 4xx with allowlisted error codes.
 * - Chain integrity is RECOMPUTED from event contents (sha256 over the
 *   stable-keyed record), never claimed.
 */

import { Router } from "express";
import { createHash } from "node:crypto";

const PACKAGE_TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Rule 17: explicit allowlists. Anything not listed here is never serialized.
const RUN_SUMMARY_FIELDS = Object.freeze([
  "packageTaskId",
  "schemaVersion",
  "orchestrator",
  "packageId",
  "agentId",
  "ownerId",
  "readiness",
  "reasonCode",
  "briefId",
  "stagesCompleted",
  "publication",
  "provenance"
]);

const RUN_DETAIL_FIELDS = Object.freeze([
  ...RUN_SUMMARY_FIELDS,
  "stages",
  "plans"
]);

const PROVENANCE_FIELDS = Object.freeze([
  "generationMode",
  "providerCalls",
  "networkCalls",
  "generatedMediaCount",
  "mediaStatus"
]);

const PUBLICATION_FIELDS = Object.freeze(["requested", "status"]);

const STAGE_FIELDS = Object.freeze([
  "stage",
  "status",
  "taskId",
  "jobType",
  "resultHash",
  "readiness",
  "reasonCode"
]);

const PLAN_SUMMARY_FIELDS = Object.freeze([
  "planType",
  "planId",
  "readiness",
  "reasonCode",
  "briefId"
]);

const EVIDENCE_PAYLOAD_FIELDS = Object.freeze([
  "stage",
  "stageTaskId",
  "resultHash",
  "readiness",
  "reasonCode",
  "errorCode",
  "packageId"
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function allowlist(source, fields) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const field of fields) {
    if (source[field] !== undefined) {
      out[field] = source[field];
    }
  }
  return out;
}

function projectProvenance(source) {
  const projected = allowlist(source?.provenance ?? source, PROVENANCE_FIELDS);
  // Counters must be numbers in the DTO; absence is preserved as null.
  for (const key of ["providerCalls", "networkCalls", "generatedMediaCount"]) {
    if (projected[key] !== undefined && !Number.isFinite(projected[key])) {
      projected[key] = null;
    }
  }
  return projected;
}

function projectPublication(source) {
  return allowlist(source?.publication, PUBLICATION_FIELDS);
}

function projectPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  return allowlist(plan, PLAN_SUMMARY_FIELDS);
}

function projectRun(run, { detail }) {
  const projected = allowlist(run, detail ? RUN_DETAIL_FIELDS : RUN_SUMMARY_FIELDS);
  projected.provenance = projectProvenance(run);
  projected.publication = projectPublication(run);
  if (detail) {
    projected.stages = Array.isArray(run.stages)
      ? run.stages.map((stage) => allowlist(stage, STAGE_FIELDS))
      : [];
    projected.plans = {
      researchBrief: projectPlan(run.researchBrief),
      editorialPlan: projectPlan(run.editorialPlan),
      metadataThumbnailPlan: projectPlan(run.metadataThumbnailPlan),
      subtitlePlan: projectPlan(run.subtitlePlan)
    };
  }
  return projected;
}

/**
 * Recomputes the evidence hash chain exactly as EvidenceLedger computes it:
 * eventHash = sha256(JSON.stringify(stable({id, occurredAt, previousHash,
 * subjectId, kind, classification, payload}))), with previousHash linking to
 * the preceding event's eventHash. Returns per-event positions plus a
 * truthful integrity verdict.
 */
function verifyChain(events) {
  let previousHash = null;
  let valid = true;
  const positions = events.map((event, index) => {
    const recomputed = sha256Hex(
      JSON.stringify(
        stable({
          id: event.id,
          occurredAt: event.occurredAt,
          previousHash: event.previousHash,
          subjectId: event.subjectId,
          kind: event.kind,
          classification: event.classification,
          payload: event.payload ?? {}
        })
      )
    );
    const linksIntact = event.previousHash === previousHash;
    const hashValid = recomputed === event.eventHash;
    if (!linksIntact || !hashValid) valid = false;
    previousHash = event.eventHash;
    return { index, linksIntact, hashValid, recomputedHash: recomputed };
  });
  return {
    length: events.length,
    firstHash: events[0]?.eventHash ?? null,
    lastHash: events.at(-1)?.eventHash ?? null,
    valid,
    positions
  };
}

function projectEvidenceEvent(event, chainPosition) {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    kind: event.kind,
    classification: event.classification,
    subjectId: event.subjectId,
    chainPosition,
    previousHash: event.previousHash ?? null,
    eventHash: event.eventHash ?? null,
    payload: allowlist(event.payload ?? {}, EVIDENCE_PAYLOAD_FIELDS)
  };
}

const EMPTY_RUN_STORE = Object.freeze({
  async listRuns() {
    return [];
  },
  async getRun() {
    return null;
  }
});

export function createContentRunsRouter({ packageRunStore, evidenceLedger } = {}) {
  const store = packageRunStore || EMPTY_RUN_STORE;

  const router = Router();

  router.get("/", async (req, res) => {
    const ownerId = req.session?.ownerId;
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const limitRaw = req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      if (typeof limitRaw !== "string" || !/^\d{1,3}$/.test(limitRaw)) {
        return res.status(400).json({ error: "QUERY_INVALID" });
      }
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: "QUERY_INVALID" });
      }
    }

    try {
      const runs = (await store.listRuns(ownerId)) ?? [];
      const projected = runs.slice(0, limit).map((run) => projectRun(run, { detail: false }));
      return res.status(200).json({
        ownerId,
        count: projected.length,
        runs: projected
      });
    } catch {
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/:packageTaskId", async (req, res) => {
    const ownerId = req.session?.ownerId;
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    const { packageTaskId } = req.params;
    if (typeof packageTaskId !== "string" || !PACKAGE_TASK_ID_PATTERN.test(packageTaskId)) {
      return res.status(400).json({ error: "PACKAGE_TASK_ID_INVALID" });
    }

    try {
      const run = await store.getRun(ownerId, packageTaskId);
      // Scope + existence are indistinguishable to the caller: a run owned by
      // someone else and a missing run are both a generic 404.
      if (!run || run.ownerId !== ownerId) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      return res.status(200).json(projectRun(run, { detail: true }));
    } catch {
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/:packageTaskId/evidence", async (req, res) => {
    const ownerId = req.session?.ownerId;
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    const { packageTaskId } = req.params;
    if (typeof packageTaskId !== "string" || !PACKAGE_TASK_ID_PATTERN.test(packageTaskId)) {
      return res.status(400).json({ error: "PACKAGE_TASK_ID_INVALID" });
    }
    if (!evidenceLedger || typeof evidenceLedger.list !== "function") {
      // Honest degradation: no evidence source configured, nothing is faked.
      return res.status(503).json({ error: "EVIDENCE_LEDGER_UNAVAILABLE" });
    }

    try {
      const run = await store.getRun(ownerId, packageTaskId);
      if (!run || run.ownerId !== ownerId) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }

      const allEvents = evidenceLedger.list();
      // Global chain positions preserve the ledger's real append order; the
      // subject filter only narrows what is RETURNED, never the positions.
      const chain = verifyChain(allEvents);
      const events = allEvents
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.subjectId === packageTaskId)
        .map(({ event, index }) => projectEvidenceEvent(event, index));

      return res.status(200).json({
        packageTaskId,
        events,
        chain: {
          length: chain.length,
          firstHash: chain.firstHash,
          lastHash: chain.lastHash,
          valid: chain.valid
        }
      });
    } catch {
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}
