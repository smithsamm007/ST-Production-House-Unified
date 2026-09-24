/**
 * Postiz publishing adapter boundary tests.
 *
 * Honest-evidence scope (contract Rule 1): these tests verify the adapter's
 * contract behavior in isolation. They prove nothing about upstream Postiz
 * quality, network behavior, or live platform operations — Postiz stays a
 * separately deployed AGPL service (Rule 11); only the boundary is under test.
 * The suite stays fully offline: no sockets, no env access, no dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  POSTIZ_PROVENANCE,
  POSTIZ_CAPABILITY,
  KNOWN_POSTIZ_TENANT_FIELDS,
  KNOWN_POSTIZ_PUBLIC_FIELDS,
  KNOWN_POSTIZ_PLATFORMS,
  buildPostizPayload,
  registerPostizAdapter,
  runPostizDispatch,
  validatePostizApproval,
  validatePostizEnvelope,
} from "../src/integrations/postizAdapter.js";

const VALID_TENANT = Object.freeze({
  agentId: "agent-01",
  agentName: "JARVIS",
  namespace: "st.agent.jarvis",
  channelSlug: "midnight-horror-hindi",
  channelDisplayName: "Midnight Horror Studios",
});

const VALID_ENVELOPE = Object.freeze({
  jobId: "job-123",
  tenant: VALID_TENANT,
  destination: {
    platform: "youtube",
    publicAttribution: "Midnight Horror Studios",
  },
  caption: "A new horror short. #horror",
  media: { uri: "file:///tmp/out.mp4", sha256: "a".repeat(64) },
  disclosure: "#ad",
});

const FUTURE_APPROVAL = Object.freeze({
  ownerId: "owner-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

test("provenance pins AGPL license, separate deployment, and zero copied source", () => {
  assert.equal(POSTIZ_PROVENANCE.upstreamLicense, "AGPL-3.0");
  assert.equal(POSTIZ_PROVENANCE.deploymentMode, "separate-deployment");
  assert.equal(POSTIZ_PROVENANCE.copiedSourceFiles, 0);
  assert.equal(POSTIZ_PROVENANCE.repository, "postiz-org/postiz-app");
});

test("capability is the reserved WORKER_CAPABILITIES.POSTIZ_PUBLISHING slot", () => {
  assert.equal(POSTIZ_CAPABILITY, "social.owner_approved_publish");
});

test("platform allowlist matches the ST platform enum exactly", () => {
  assert.deepEqual([...KNOWN_POSTIZ_PLATFORMS].sort(), ["facebook", "instagram", "snapchat", "youtube"]);
});

test("envelope validation: valid envelope passes through", () => {
  const out = validatePostizEnvelope({ ...VALID_ENVELOPE });
  assert.equal(out.jobId, "job-123");
});

test("envelope validation: missing jobId throws", () => {
  assert.throws(
    () => validatePostizEnvelope({ ...VALID_ENVELOPE, jobId: undefined }),
    /JOB_ID_REQUIRED/,
  );
});

test("envelope validation: missing tenant context throws", () => {
  assert.throws(() => validatePostizEnvelope({ ...VALID_ENVELOPE, tenant: undefined }), /POSTIZ_TENANT_CONTEXT_REQUIRED/);
});

test("envelope validation: tenant missing any required field throws", () => {
  for (const field of KNOWN_POSTIZ_TENANT_FIELDS) {
    const partial = { ...VALID_TENANT };
    delete partial[field];
    assert.throws(
      () => validatePostizEnvelope({ ...VALID_ENVELOPE, tenant: partial }),
      /POSTIZ_TENANT_CONTEXT_REQUIRED/,
      `expected failure when tenant field ${field} is absent`,
    );
  }
});

test("envelope validation: unknown platform fails closed", () => {
  assert.throws(
    () => validatePostizEnvelope({
      ...VALID_ENVELOPE,
      destination: { ...VALID_ENVELOPE.destination, platform: "tiktok" },
    }),
    /UNKNOWN_POSTIZ_PLATFORM/,
  );
});

test("envelope validation: missing media sha256 fails closed", () => {
  assert.throws(
    () => validatePostizEnvelope({
      ...VALID_ENVELOPE,
      media: { uri: "file:///tmp/out.mp4" },
    }),
    /POSTIZ_MEDIA_SHA256_REQUIRED/,
  );
});

test("approval validation: unexpired owner approval passes", () => {
  validatePostizApproval(FUTURE_APPROVAL, { now: new Date() });
});

test("approval validation: missing approval throws", () => {
  assert.throws(() => validatePostizApproval(undefined, { now: new Date() }), /OWNER_APPROVAL_REQUIRED/);
});

test("approval validation: expired approval fails closed", () => {
  const expired = { ownerId: "owner-1", expiresAt: "2026-01-01T00:00:00.000Z" };
  assert.throws(() => validatePostizApproval(expired, { now: new Date("2026-09-24T00:00:00.000Z") }), /APPROVAL_EXPIRED/);
});

test("approval validation: malformed expiry fails closed", () => {
  assert.throws(
    () => validatePostizApproval({ ownerId: "owner-1", expiresAt: "not-a-date" }, { now: new Date() }),
    /OWNER_APPROVAL_EXPIRY_REQUIRED/,
  );
});

test("payload allowlist: only public fields serialize — internal names never leave", () => {
  const payload = buildPostizPayload(VALID_ENVELOPE);
  const payloadJson = JSON.stringify(payload);
  for (const field of KNOWN_POSTIZ_PUBLIC_FIELDS) {
    if (VALID_ENVELOPE[field] !== undefined) {
      assert.ok(field in payload, `expected public field ${field} in payload`);
    }
  }
  assert.ok(payload.publicAttribution === "Midnight Horror Studios");
  assert.ok(!payloadJson.includes("JARVIS"), "internal agent name must never serialize (Rule 15)");
  assert.ok(!payloadJson.includes("agent-01"), "internal agent id must never serialize (Rule 15)");
  assert.ok(!payloadJson.includes("st.agent.jarvis"), "internal namespace must never serialize (Rule 15)");
  assert.ok(!("tenant" in payload), "tenant block must never serialize (Rule 15)");
});

test("payload allowlist: disclosure omitted when absent", () => {
  const payload = buildPostizPayload({ ...VALID_ENVELOPE, disclosure: undefined });
  assert.ok(!("disclosure" in payload));
});

test("registry: registering returns a NEW frozen registry and never mutates the input", () => {
  const registry = Object.freeze({});
  const next = registerPostizAdapter(registry, { capability: POSTIZ_CAPABILITY, run: async () => ({}) });
  assert.notEqual(next, registry);
  assert.equal(typeof next[POSTIZ_CAPABILITY], "function");
  assert.ok(!(POSTIZ_CAPABILITY in registry));
  assert.ok(Object.isFrozen(next));
});

test("registry: mismatched capability fails closed", () => {
  assert.throws(
    () => registerPostizAdapter({}, { capability: "not.postiz", run: async () => ({}) }),
    /ADAPTER_CAPABILITY_MISMATCH/,
  );
});

test("registry: run must be a function", () => {
  assert.throws(
    () => registerPostizAdapter({}, { capability: POSTIZ_CAPABILITY, run: "nope" }),
    /ADAPTER_RUN_NOT_A_FUNCTION/,
  );
});

test("dispatch: success requires ledger-verified evidence and returns a worker-valid result", async () => {
  const fetchEvidence = async (receiptId) => ({ found: true, receiptId });
  const result = await runPostizDispatch(
    VALID_ENVELOPE,
    FUTURE_APPROVAL,
    async (payload) => {
      assert.equal(payload.platform, "youtube");
      return { evidence: { receiptId: "receipt-1" } };
    },
    { fetchEvidence, correlationId: "corr-9" },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.capability, POSTIZ_CAPABILITY);
  assert.equal(result.artifact.sha256, "a".repeat(64));
  assert.equal(result.evidence.verifiedByLedger, true);
  assert.equal(result.evidence.receiptId, "receipt-1");
  assert.equal(result.evidence.correlationId, "corr-9");
});

test("dispatch: refuses to run without an unexpired owner approval (Rule 7)", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      VALID_ENVELOPE,
      { ownerId: "owner-1", expiresAt: "2026-01-01T00:00:00.000Z" },
      async () => ({ evidence: { receiptId: "r" } }),
      { fetchEvidence: async () => ({ found: true }) },
    ),
    /APPROVAL_EXPIRED/,
  );
});

test("dispatch: run result without a receipt id fails closed (Rule 1)", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      VALID_ENVELOPE,
      FUTURE_APPROVAL,
      async () => ({ evidence: {} }),
      { fetchEvidence: async () => ({ found: true }) },
    ),
    /POSTIZ_RESULT_MISSING_EVIDENCE/,
  );
});

test("dispatch: unverified ledger record fails closed — Postiz cannot self-certify", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      VALID_ENVELOPE,
      FUTURE_APPROVAL,
      async () => ({ evidence: { receiptId: "receipt-1" } }),
      { fetchEvidence: async () => ({ found: false }) },
    ),
    /POSTIZ_EVIDENCE_UNVERIFIED/,
  );
});

test("dispatch: evidence lookup failure fails closed", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      VALID_ENVELOPE,
      FUTURE_APPROVAL,
      async () => ({ evidence: { receiptId: "receipt-1" } }),
      { fetchEvidence: async () => null },
    ),
    /POSTIZ_EVIDENCE_LOOKUP_FAILED/,
  );
});

test("dispatch: run failures propagate unchanged — no swallowing", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      VALID_ENVELOPE,
      FUTURE_APPROVAL,
      async () => {
        throw new Error("POSTIZ_HTTP_503");
      },
      { fetchEvidence: async () => ({ found: true }) },
    ),
    /POSTIZ_HTTP_503/,
  );
});

test("dispatch: invalid envelope never reaches the run function", async () => {
  let ran = false;
  await assert.rejects(
    () => runPostizDispatch(
      { ...VALID_ENVELOPE, jobId: undefined },
      FUTURE_APPROVAL,
      async () => {
        ran = true;
        return { evidence: { receiptId: "r" } };
      },
      { fetchEvidence: async () => ({ found: true }) },
    ),
    /JOB_ID_REQUIRED/,
  );
  assert.equal(ran, false);
});

test("dispatch: result artifact sha256 is enforced by validateWorkerResult", async () => {
  await assert.rejects(
    () => runPostizDispatch(
      { ...VALID_ENVELOPE, media: { uri: "file:///tmp/out.mp4", sha256: "deadbeef" } },
      FUTURE_APPROVAL,
      async () => ({ evidence: { receiptId: "receipt-1" } }),
      { fetchEvidence: async () => ({ found: true }) },
    ),
    /POSTIZ_MEDIA_SHA256_REQUIRED/,
  );
});
