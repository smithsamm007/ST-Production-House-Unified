/**
 * External production-engine adapter boundary tests — AgentTube engine.
 *
 * Honest-evidence scope (contract Rule 1): these tests verify the adapter's
 * contract behavior in isolation. They prove nothing about upstream AgentTube
 * quality, network behavior, or live YouTube operations — the engine stays an
 * external component; only the boundary is under test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENTUBE_PROVENANCE,
  KNOWN_AGENTUBE_CAPABILITIES,
  KNOWN_AGENTUBE_TENANT_FIELDS,
  registerAgenticProductionEngineAdapter,
  runAgenticProductionEngineJob,
  validateAgenticProductionEnvelope,
} from "../src/integrations/agenticProductionEngine.js";

const VALID_TENANT = Object.freeze({
  agentId: "agent-01",
  agentName: "JARVIS",
  namespace: "st.agent.jarvis",
  channelSlug: "midnight-horror-hindi",
  channelDisplayName: "Midnight Horror Studios",
});

const VALID_ENVELOPE = Object.freeze({
  jobId: "job-123",
  capability: "video.production",
  tenant: VALID_TENANT,
});

const GOOD_RUN_RESULT = Object.freeze({
  artifact: { uri: "file:///tmp/out.mp4", sha256: "a".repeat(64) },
  evidence: { receiptId: "receipt-1" },
});

test("provenance pins upstream license and zero copied source", () => {
  assert.equal(AGENTUBE_PROVENANCE.upstreamLicense, "MIT");
  assert.equal(AGENTUBE_PROVENANCE.copiedSourceFiles, 0);
  assert.equal(AGENTUBE_PROVENANCE.repository, "darkzOGx/youtube-automation-agent");
});

test("capability catalog matches the upstream pipeline stages without inventing states", () => {
  assert.ok(KNOWN_AGENTUBE_CAPABILITIES.includes("youtube.upload"));
  assert.ok(KNOWN_AGENTUBE_CAPABILITIES.includes("publishing.approval_gate"));
  assert.ok(!KNOWN_AGENTUBE_CAPABILITIES.includes("bogus.capability"));
});

test("envelope validation: valid envelope passes through", () => {
  const out = validateAgenticProductionEnvelope({ ...VALID_ENVELOPE });
  assert.equal(out.jobId, "job-123");
  assert.equal(out.capability, "video.production");
});

test("envelope validation: missing jobId throws", () => {
  assert.throws(() => validateAgenticProductionEnvelope({ capability: "video.production", tenant: VALID_TENANT }), /JOB_ID_REQUIRED/);
});

test("envelope validation: unknown capability fails closed", () => {
  assert.throws(
    () => validateAgenticProductionEnvelope({ ...VALID_ENVELOPE, capability: "not.a.capability" }),
    /UNKNOWN_AGENTUBE_CAPABILITY/
  );
});

test("envelope validation: missing tenant context throws", () => {
  assert.throws(() => validateAgenticProductionEnvelope({ jobId: "j", capability: "video.production" }), /AGENTUBE_TENANT_CONTEXT_REQUIRED/);
});

test("envelope validation: tenant missing any required field throws", () => {
  for (const field of KNOWN_AGENTUBE_TENANT_FIELDS) {
    const partial = { ...VALID_TENANT };
    delete partial[field];
    assert.throws(
      () => validateAgenticProductionEnvelope({ jobId: "j", capability: "video.production", tenant: partial }),
      /AGENTUBE_TENANT_CONTEXT_REQUIRED/,
      `expected failure when tenant field ${field} is absent`
    );
  }
});

test("adapter registry: registers valid capability and never mutates the caller's registry", () => {
  const base = Object.freeze({ "video.production": async () => GOOD_RUN_RESULT });
  const run = async () => GOOD_RUN_RESULT;
  const next = registerAgenticProductionEngineAdapter(base, { capability: "seo.packaging", run });
  assert.equal(typeof next["seo.packaging"], "function");
  assert.equal(next["video.production"], base["video.production"]);
  assert.equal(Object.isFrozen(next), true);
});

test("adapter registry: unknown capability is rejected", () => {
  assert.throws(
    () => registerAgenticProductionEngineAdapter({}, { capability: "bogus", run: async () => ({}) }),
    /ADAPTER_CAPABILITY_MISMATCH/
  );
});

test("adapter registry: run must be a function", () => {
  assert.throws(
    () => registerAgenticProductionEngineAdapter({}, { capability: "video.production", run: "nope" }),
    /ADAPTER_RUN_NOT_A_FUNCTION/
  );
});

test("run job: success path returns ledger-verified worker result", async () => {
  const calls = [];
  const result = await runAgenticProductionEngineJob(VALID_ENVELOPE, async () => ({ ...GOOD_RUN_RESULT }), {
    fetchEvidence: async (receiptId) => {
      calls.push(receiptId);
      return { found: true, verifiedAt: "2026-09-24T00:00:00Z" };
    },
  });
  assert.deepEqual(calls, ["receipt-1"]);
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.verifiedByLedger, true);
  assert.equal(result.artifact.sha256, "a".repeat(64));
});

test("run job: engine result without evidence receipt throws (no self-certification)", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => ({ artifact: GOOD_RUN_RESULT.artifact }), {
      fetchEvidence: async () => ({ found: true }),
    }),
    /AGENTUBE_RESULT_MISSING_EVIDENCE/
  );
});

test("run job: unverified evidence receipt fails the job (Rule 1)", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => ({ ...GOOD_RUN_RESULT }), {
      fetchEvidence: async () => ({ found: false }),
    }),
    /AGENTUBE_EVIDENCE_UNVERIFIED/
  );
});

test("run job: evidence-lookup failure fails the job honestly", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => ({ ...GOOD_RUN_RESULT }), {
      fetchEvidence: async () => null,
    }),
    /AGENTUBE_EVIDENCE_LOOKUP_FAILED/
  );
});

test("run job: adapter failures propagate unchanged (no swallowing)", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => {
      throw new Error("UPSTREAM_PROVIDER_TIMEOUT");
    }, { fetchEvidence: async () => ({ found: true }) }),
    /UPSTREAM_PROVIDER_TIMEOUT/
  );
});

test("run job: malformed engine result is rejected", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => null, {
      fetchEvidence: async () => ({ found: true }),
    }),
    /INVALID_AGENTUBE_RESULT/
  );
});

test("run job: invalid sha256 in engine artifact cannot pass the worker contract", async () => {
  await assert.rejects(
    runAgenticProductionEngineJob(VALID_ENVELOPE, async () => ({
      artifact: { uri: "file:///tmp/out.mp4", sha256: "not-a-hash" },
      evidence: { receiptId: "receipt-2" },
    }), { fetchEvidence: async () => ({ found: true }) }),
    /SUCCESS_REQUIRES_ARTIFACT_AND_EVIDENCE/
  );
});
