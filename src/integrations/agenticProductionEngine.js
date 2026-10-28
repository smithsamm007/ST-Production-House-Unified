/**
 * External production-engine adapter boundary — "AgentTube" engine.
 *
 * Provenance (verified 2026-09-24 against the GitHub API):
 *   - repository: darkzOGx/youtube-automation-agent, default branch `master`
 *   - upstream license: MIT ("Copyright (c) 2025 YouTube Automation Agent
 *     Contributors"), package version v2.10.0
 *   - upstream open work exists (e.g. PR #40 "fix: bind dashboard to loopback
 *     by default" is still OPEN/unmerged), so its master is NOT treated as
 *     fully hardened; this adapter therefore only consumes the engine's
 *     job-scoped RESULTS through the same evidence contract every other
 *     integration uses.
 *
 * Contract rules honored here (AGENTS.md Part 1 + Part 2):
 *   - Rule 10: no upstream source is pasted into this codebase; the engine
 *     stays an external component reached through this adapter. Zero upstream
 *     files are copied (`copiedSourceFiles: 0`).
 *   - Rule 17/R2: this module holds no secrets and accepts job-scoped inputs
 *     only; result serialization stays inside validateWorkerResult.
 *   - Rule 1: a result is success ONLY when the ST evidence ledger confirms
 *     the receipt. Upstream "done" without durable ST evidence is failure —
 *     the engine cannot self-certify its own work.
 *   - R5: no new status states — outcomes are expressed through the existing
 *     worker-result lifecycle (succeeded | failed) already enforced by
 *     validateWorkerResult.
 *   - Rule 15: agent names are ST-internal tenant-scoping identifiers and are
 *     always required on envelopes; they never serialize into public content
 *     (this module never produces public content at all).
 *
 * This file performs NO network I/O. The deployer binds the engine to an
 * environment (process, container, or API base URL) at their own risk, and
 * every run must still produce evidence the ST ledger can verify.
 */

import { validateWorkerResult } from "./contracts.js";

/**
 * Durable provenance record for the external engine binding.
 * `copiedSourceFiles` MUST stay 0: adapting means calling, not pasting.
 */
export const AGENTUBE_PROVENANCE = Object.freeze({
  engineId: "agentube",
  repository: "darkzOGx/youtube-automation-agent",
  ref: "master",
  upstreamLicense: "MIT",
  upstreamVersion: "v2.10.0",
  assessedAt: "2026-09-24",
  copiedSourceFiles: 0,
});

/**
 * Capabilities this adapter is allowed to expose for the external engine.
 * One engine, many capabilities — but every capability still runs inside one
 * ST job lifecycle with one evidence receipt (single engine ≠ shared secrets:
 * jobs remain scoped to one agent and one task slot per Rule 5).
 */
export const KNOWN_AGENTUBE_CAPABILITIES = Object.freeze([
  "research.strategy",
  "script.generation",
  "thumbnail.generation",
  "seo.packaging",
  "video.production",
  "youtube.upload",
  "publishing.approval_gate",
  "analytics.learning_loop",
  "shorts.repurposing",
]);

/**
 * Required tenant-isolation fields on every envelope. The owner's directors
 * are internal identities; the engine never sees or derives public branding.
 */
export const KNOWN_AGENTUBE_TENANT_FIELDS = Object.freeze([
  "agentId",
  "agentName",
  "namespace",
  "channelSlug",
  "channelDisplayName",
]);

/**
 * Validate a job envelope for the external engine. Throws (fail closed) on
 * any missing or unknown field. Pure: no I/O, no mutation.
 */
export function validateAgenticProductionEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("JOB_ID_REQUIRED");
  }
  if (typeof envelope.jobId !== "string" || envelope.jobId.length === 0) {
    throw new Error("JOB_ID_REQUIRED");
  }
  if (typeof envelope.capability !== "string" || envelope.capability.length === 0) {
    throw new Error("CAPABILITY_REQUIRED");
  }
  if (!KNOWN_AGENTUBE_CAPABILITIES.includes(envelope.capability)) {
    throw new Error("UNKNOWN_AGENTUBE_CAPABILITY");
  }
  const tenant = envelope.tenant;
  if (!tenant || typeof tenant !== "object" || Array.isArray(tenant)) {
    throw new Error("AGENTUBE_TENANT_CONTEXT_REQUIRED");
  }
  for (const field of KNOWN_AGENTUBE_TENANT_FIELDS) {
    const value = tenant[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("AGENTUBE_TENANT_CONTEXT_REQUIRED");
    }
  }
  return envelope;
}

/**
 * Register an adapter implementation for one capability.
 *
 * Returns a NEW frozen registry; the caller's registry object is never
 * mutated, so no third-party component can silently rewrite the worker map.
 */
export function registerAgenticProductionEngineAdapter(registry, adapter) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("ADAPTER_REGISTRY_REQUIRED");
  }
  if (!adapter || typeof adapter !== "object") {
    throw new Error("ADAPTER_CAPABILITY_MISMATCH");
  }
  if (!KNOWN_AGENTUBE_CAPABILITIES.includes(adapter.capability)) {
    throw new Error("ADAPTER_CAPABILITY_MISMATCH");
  }
  if (typeof adapter.run !== "function") {
    throw new Error("ADAPTER_RUN_NOT_A_FUNCTION");
  }
  return Object.freeze({
    ...registry,
    [adapter.capability]: adapter.run,
  });
}

/**
 * Run one engine job and enforce the evidence contract around it.
 *
 *   envelope      validated job envelope (see validateAgenticProductionEnvelope)
 *   run           the adapter's execution function (invoked with the envelope)
 *   fetchEvidence async (receiptId) => ({ found: boolean, ... }) — the ST
 *                 evidence ledger lookup. Success requires found:true.
 *
 * Success → a frozen, validateWorkerResult-compliant result whose evidence
 * carries `verifiedByLedger: true`.
 * Anything else → throws; callers treat the job as failed (never "probably done").
 * The `run` function's own failures propagate unchanged — no swallowing.
 */
export async function runAgenticProductionEngineJob(envelope, run, { fetchEvidence, correlationId } = {}) {
  validateAgenticProductionEnvelope(envelope);
  if (typeof run !== "function") {
    throw new Error("AGENTUBE_RUN_NOT_A_FUNCTION");
  }
  if (typeof fetchEvidence !== "function") {
    throw new Error("AGENTUBE_EVIDENCE_LOOKUP_REQUIRED");
  }

  const result = await run(envelope);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("INVALID_AGENTUBE_RESULT");
  }
  const receiptId = result?.evidence?.receiptId;
  if (typeof receiptId !== "string" || receiptId.length === 0) {
    throw new Error("AGENTUBE_RESULT_MISSING_EVIDENCE");
  }

  const ledgerRecord = await fetchEvidence(receiptId);
  if (!ledgerRecord || typeof ledgerRecord !== "object") {
    throw new Error("AGENTUBE_EVIDENCE_LOOKUP_FAILED");
  }
  if (ledgerRecord.found !== true) {
    throw new Error("AGENTUBE_EVIDENCE_UNVERIFIED");
  }

  const verifiedAt = typeof ledgerRecord.verifiedAt === "string"
    ? ledgerRecord.verifiedAt
    : new Date().toISOString();

  const wrapped = {
    jobId: envelope.jobId,
    capability: envelope.capability,
    status: "succeeded",
    artifact: {
      uri: result.artifact?.uri,
      sha256: result.artifact?.sha256,
    },
    evidence: {
      receiptId,
      verifiedAt,
      verifiedByLedger: true,
      engineId: AGENTUBE_PROVENANCE.engineId,
      ...(correlationId ? { correlationId } : {}),
    },
  };
  // validateWorkerResult enforces: sha256 hex shape, artifact.uri present,
  // evidence.receiptId present — the same bar every ST worker must clear.
  return validateWorkerResult(wrapped);
}
