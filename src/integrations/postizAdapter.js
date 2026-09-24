/**
 * Postiz publishing adapter boundary (AGPL-3.0, separately deployed).
 *
 * Provenance (verified 2026-09-24 against the Postiz public repository):
 *   - repository: postiz-org/postiz-app, default branch `main`
 *   - upstream license: AGPL-3.0 — per contract Rule 11, Postiz must remain a
 *     SEPARATELY DEPLOYED service reached only through this API adapter.
 *     No upstream source is pasted into ST (Rule 10).
 *   - upstream open hardening work exists (self-host auth hardening PRs were
 *     still open at assessment), so Postiz output is treated exactly like any
 *     other third-party component: it cannot self-certify its own work.
 *
 * Contract rules honored here (AGENTS.md Part 1 + Part 2):
 *   - Rule 11: Postiz stays an external AGPL deployment; this file contains
 *     zero upstream source and zero network I/O. The deployer binds the real
 *     Postiz base URL and token in their runtime; this module never reads
 *     env vars, never fetches, never stores secrets (Rule 17).
 *   - Rule 7: dispatch REQUIRES an unexpired owner approval bound to the
 *     exact artifact hash, destination, caption, affiliate links, and
 *     disclosure. A missing/expired approval fails closed.
 *   - Rule 1: a publish counts as succeeded ONLY when the ST evidence ledger
 *     confirms the receipt; Postiz "accepted" without durable ST evidence is
 *     failure, not success.
 *   - Rule 15: the payload handed to Postiz is built exclusively from
 *     PUBLIC fields. Internal agent names/IDs are consumed for tenant scoping
 *     and NEVER serialize into the outbound payload.
 *   - R5: no new status states — dispatch outcomes reuse the existing
 *     worker-result lifecycle (succeeded | failed) enforced by
 *     validateWorkerResult; in-flight outcomes stay `awaiting_owner_approval`
 *     / `approved` exactly as defined in publishingService.
 *   - Rule 5: each envelope is scoped to one agent and one task slot; two
 *     agents never share one dispatch.
 *
 * This file performs NO network I/O. It is the callable boundary the
 * deployer's runtime (or a future worker) drives.
 */

import { validateWorkerResult, WORKER_CAPABILITIES } from "./contracts.js";

export const POSTIZ_CAPABILITY = WORKER_CAPABILITIES.POSTIZ_PUBLISHING;

/**
 * Durable provenance record for the Postiz binding.
 * `copiedSourceFiles` MUST stay 0: integrating means calling, not pasting.
 */
export const POSTIZ_PROVENANCE = Object.freeze({
  engineId: "postiz",
  repository: "postiz-org/postiz-app",
  ref: "main",
  upstreamLicense: "AGPL-3.0",
  deploymentMode: "separate-deployment",
  assessedAt: "2026-09-24",
  copiedSourceFiles: 0,
});

/**
 * Required tenant-isolation fields on every envelope (Rule 5). Same shape as
 * the AgentTube adapter so operators reason about ONE tenant model.
 */
export const KNOWN_POSTIZ_TENANT_FIELDS = Object.freeze([
  "agentId",
  "agentName",
  "namespace",
  "channelSlug",
  "channelDisplayName",
]);

/**
 * Public payload fields Postiz may receive. Enforced by allowlist: anything
 * not listed here is dropped before serialization (Rule 17/R2, safe DTO).
 */
export const KNOWN_POSTIZ_PUBLIC_FIELDS = Object.freeze([
  "publicAttribution",
  "caption",
  "platform",
  "mediaUri",
  "mediaSha256",
  "disclosure",
]);

/**
 * Platform allowlist — matches the ST platform enum exactly. Postiz is never
 * told about platforms outside the ST contract.
 */
export const KNOWN_POSTIZ_PLATFORMS = Object.freeze([
  "youtube",
  "instagram",
  "facebook",
  "snapchat",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Validate a Postiz job envelope. Throws (fail closed) on any missing or
 * unknown field. Pure: no I/O, no mutation.
 *
 * Required envelope shape:
 *   {
 *     jobId, tenant: {agentId, agentName, namespace, channelSlug,
 *                     channelDisplayName},
 *     destination: {platform, publicAttribution},
 *     caption, media: {uri, sha256}, approval: {ownerId, expiresAt, ...}
 *   }
 */
export function validatePostizEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("JOB_ID_REQUIRED");
  }
  if (!isNonEmptyString(envelope.jobId)) {
    throw new Error("JOB_ID_REQUIRED");
  }
  if (!envelope.tenant || typeof envelope.tenant !== "object" || Array.isArray(envelope.tenant)) {
    throw new Error("POSTIZ_TENANT_CONTEXT_REQUIRED");
  }
  for (const field of KNOWN_POSTIZ_TENANT_FIELDS) {
    if (!isNonEmptyString(envelope.tenant[field])) {
      throw new Error("POSTIZ_TENANT_CONTEXT_REQUIRED");
    }
  }
  if (!envelope.destination || typeof envelope.destination !== "object" || Array.isArray(envelope.destination)) {
    throw new Error("POSTIZ_DESTINATION_REQUIRED");
  }
  if (!isNonEmptyString(envelope.destination.publicAttribution)) {
    throw new Error("POSTIZ_PUBLIC_ATTRIBUTION_REQUIRED");
  }
  if (!isNonEmptyString(envelope.destination.platform)) {
    throw new Error("POSTIZ_PLATFORM_REQUIRED");
  }
  if (!KNOWN_POSTIZ_PLATFORMS.includes(envelope.destination.platform)) {
    throw new Error("UNKNOWN_POSTIZ_PLATFORM");
  }
  if (!isNonEmptyString(envelope.caption)) {
    throw new Error("POSTIZ_CAPTION_REQUIRED");
  }
  if (!envelope.media || typeof envelope.media !== "object" || Array.isArray(envelope.media)) {
    throw new Error("POSTIZ_MEDIA_REQUIRED");
  }
  if (!isNonEmptyString(envelope.media.uri)) {
    throw new Error("POSTIZ_MEDIA_URI_REQUIRED");
  }
  if (!isSha256Hex(envelope.media.sha256)) {
    throw new Error("POSTIZ_MEDIA_SHA256_REQUIRED");
  }
  return envelope;
}

/**
 * Validate the owner approval (Rule 7). The approval must exist, carry an
 * owner id, and be unexpired. `now` is injectable for tests; defaults to the
 * real clock ONLY at call time.
 */
export function validatePostizApproval(approval, { now = new Date() } = {}) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error("OWNER_APPROVAL_REQUIRED");
  }
  if (!isNonEmptyString(approval.ownerId)) {
    throw new Error("OWNER_APPROVAL_REQUIRED");
  }
  if (!isNonEmptyString(approval.expiresAt) || Number.isNaN(Date.parse(approval.expiresAt))) {
    throw new Error("OWNER_APPROVAL_EXPIRY_REQUIRED");
  }
  if (new Date(approval.expiresAt) <= now) {
    throw new Error("APPROVAL_EXPIRED");
  }
  return approval;
}

/**
 * Build the outbound payload Postiz receives. PUBLIC FIELDS ONLY — the
 * allowlist guarantees internal agent identifiers (Rule 15) and secret-shaped
 * fields (Rule 17) never serialize. Pure: returns a new frozen object.
 */
export function buildPostizPayload(envelope) {
  validatePostizEnvelope(envelope);
  const source = {
    publicAttribution: envelope.destination.publicAttribution,
    caption: envelope.caption,
    platform: envelope.destination.platform,
    mediaUri: envelope.media.uri,
    mediaSha256: envelope.media.sha256,
    disclosure: envelope.disclosure,
  };
  const payload = {};
  for (const field of KNOWN_POSTIZ_PUBLIC_FIELDS) {
    if (source[field] !== undefined) {
      payload[field] = source[field];
    }
  }
  return Object.freeze(payload);
}

/**
 * Register an adapter implementation for the Postiz capability.
 *
 * Returns a NEW frozen registry; the caller's registry object is never
 * mutated, so no third-party component can silently rewrite the dispatch map.
 */
export function registerPostizAdapter(registry, adapter) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("ADAPTER_REGISTRY_REQUIRED");
  }
  if (!adapter || typeof adapter !== "object") {
    throw new Error("ADAPTER_CAPABILITY_MISMATCH");
  }
  if (adapter.capability !== POSTIZ_CAPABILITY) {
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
 * Run one owner-approved Postiz dispatch and enforce the evidence contract:
 *
 *   envelope      validated job envelope (see validatePostizEnvelope)
 *   approval      owner approval {ownerId, expiresAt} — must be unexpired
 *   run           async (payload) => ({ evidence: { receiptId } }); the
 *                 deployer's runtime function that actually calls Postiz
 *   fetchEvidence async (receiptId) => ({ found: boolean, ... }) — the ST
 *                 evidence-ledger lookup. Success requires found:true.
 *
 * Success → a frozen, validateWorkerResult-compliant result whose evidence
 * carries `verifiedByLedger: true`.
 * Anything else → throws; callers treat the job as failed (never "probably
 * posted"). The `run` function's own failures propagate unchanged.
 */
export async function runPostizDispatch(envelope, approval, run, { fetchEvidence, correlationId, now } = {}) {
  validatePostizEnvelope(envelope);
  validatePostizApproval(approval, { now });
  if (typeof run !== "function") {
    throw new Error("POSTIZ_RUN_NOT_A_FUNCTION");
  }
  if (typeof fetchEvidence !== "function") {
    throw new Error("POSTIZ_EVIDENCE_LOOKUP_REQUIRED");
  }

  const payload = buildPostizPayload(envelope);
  const result = await run(payload);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("INVALID_POSTIZ_RESULT");
  }
  const receiptId = result?.evidence?.receiptId;
  if (!isNonEmptyString(receiptId)) {
    throw new Error("POSTIZ_RESULT_MISSING_EVIDENCE");
  }

  const ledgerRecord = await fetchEvidence(receiptId);
  if (!ledgerRecord || typeof ledgerRecord !== "object") {
    throw new Error("POSTIZ_EVIDENCE_LOOKUP_FAILED");
  }
  if (ledgerRecord.found !== true) {
    throw new Error("POSTIZ_EVIDENCE_UNVERIFIED");
  }

  const verifiedAt = isNonEmptyString(ledgerRecord.verifiedAt)
    ? ledgerRecord.verifiedAt
    : new Date().toISOString();

  return validateWorkerResult(Object.freeze({
    jobId: envelope.jobId,
    capability: POSTIZ_CAPABILITY,
    status: "succeeded",
    artifact: {
      uri: envelope.media.uri,
      sha256: envelope.media.sha256,
    },
    evidence: {
      receiptId,
      verifiedAt,
      verifiedByLedger: true,
      engineId: POSTIZ_PROVENANCE.engineId,
      platform: envelope.destination.platform,
      ...(correlationId ? { correlationId } : {}),
    },
  }));
}
