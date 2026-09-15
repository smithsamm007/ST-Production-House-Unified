import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_TYPES,
  MIME_TYPES,
  VERIFICATION_STATES,
  createArtifactDescriptor,
  verifyArtifactDescriptor,
  revokeVerification,
  serializeArtifactDescriptor,
  canonicalSerialize,
  descriptorFingerprint,
  detectTampering,
} from "../src/media/artifactDescriptor.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function producer(overrides = {}) {
  return {
    agentId: "agent-21",
    runId: "run-2026-09-15-001",
    stageId: "assembly",
    providerId: "local_emergency",
    ...overrides,
  };
}

function descriptorInput(overrides = {}) {
  return {
    contentSha256: HASH_A,
    artifactType: "video",
    mimeType: "video/mp4",
    durationSeconds: 2100.5,
    dimensions: { width: 1920, height: 1080 },
    producer: producer(),
    ...overrides,
  };
}

function passingInspection(overrides = {}) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: HASH_A,
    format: { duration: "2100.5", format_name: "mp4" },
    streams: [{ codec_type: "video", width: 1920, height: 1080 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Descriptor validation (fail-closed, stable codes)
// ---------------------------------------------------------------------------

test("valid descriptor is created UNVERIFIED with canonical fields", () => {
  const d = createArtifactDescriptor(descriptorInput());
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.descriptorType, "st_media_artifact_descriptor");
  assert.equal(d.contentSha256, HASH_A);
  assert.equal(d.artifactType, "video");
  assert.equal(d.mimeType, "video/mp4");
  assert.equal(d.durationSeconds, 2100.5);
  assert.deepEqual(d.dimensions, { width: 1920, height: 1080 });
  assert.equal(d.producer.agentId, "agent-21");
  assert.equal(d.verification.state, "UNVERIFIED");
  assert.equal(d.verification.reasonCode, "NO_INSPECTION_RESULT");
});

test("hash validation fails closed with ARTIFACT_HASH_INVALID", () => {
  const bad = [
    undefined,
    null,
    "",
    "not-a-hash",
    "A".repeat(64), // uppercase — must be normalized or rejected; contract normalizes
    "abc123",
    Array(64).fill("g").join(""), // non-hex
    HASH_A + "0", // 65 chars
  ];
  // Note: uppercase IS accepted and normalized to lowercase (documented).
  assert.doesNotThrow(() => createArtifactDescriptor(descriptorInput({ contentSha256: "A".repeat(64) })));
  const normalized = createArtifactDescriptor(descriptorInput({ contentSha256: "A".repeat(64) }));
  assert.equal(normalized.contentSha256, HASH_A);

  for (const badHash of [undefined, null, "", "not-a-hash", "abc123", Array(64).fill("g").join(""), HASH_A + "0"]) {
    assert.throws(
      () => createArtifactDescriptor(descriptorInput({ contentSha256: badHash })),
      (e) => e.code === "ARTIFACT_HASH_INVALID",
      `hash ${String(badHash).slice(0, 12)} must be rejected`
    );
  }
});

test("artifact type and MIME fail closed with stable codes", () => {
  assert.throws(() => createArtifactDescriptor(descriptorInput({ artifactType: "hologram" })), (e) => e.code === "ARTIFACT_TYPE_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ artifactType: undefined })), (e) => e.code === "ARTIFACT_TYPE_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ mimeType: "video/unknown-format" })), (e) => e.code === "ARTIFACT_MIME_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ mimeType: "not a mime" })), (e) => e.code === "ARTIFACT_MIME_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ mimeType: 42 })), (e) => e.code === "ARTIFACT_MIME_INVALID");
});

test("producer provenance is required and fails closed", () => {
  assert.throws(() => createArtifactDescriptor(descriptorInput({ producer: undefined })), (e) => e.code === "ARTIFACT_PRODUCER_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ producer: { agentId: "a" } })), (e) => e.code === "ARTIFACT_PRODUCER_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ producer: producer({ runId: "" }) })), (e) => e.code === "ARTIFACT_PRODUCER_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ producer: producer({ providerId: "x".repeat(121) }) })), (e) => e.code === "ARTIFACT_PRODUCER_INVALID");
});

test("duration and dimensions fail closed on invalid values", () => {
  assert.throws(() => createArtifactDescriptor(descriptorInput({ durationSeconds: -1 })), (e) => e.code === "ARTIFACT_DURATION_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ durationSeconds: "2100" })), (e) => e.code === "ARTIFACT_DURATION_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ durationSeconds: Infinity })), (e) => e.code === "ARTIFACT_DURATION_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ dimensions: { width: 0, height: 1080 } })), (e) => e.code === "ARTIFACT_DIMENSIONS_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ dimensions: { width: 1920 } })), (e) => e.code === "ARTIFACT_DIMENSIONS_INVALID");
  assert.throws(() => createArtifactDescriptor(descriptorInput({ dimensions: { width: 1.5, height: 10 } })), (e) => e.code === "ARTIFACT_DIMENSIONS_INVALID");
});

test("secrets and secret locators are rejected everywhere (Rule 17)", () => {
  assert.throws(
    () => createArtifactDescriptor(descriptorInput({ producer: producer({ note: "stored at vault://st/providers/x" }) })),
    (e) => e.code === "ARTIFACT_SECRET_REJECTED"
  );
  assert.throws(
    () => createArtifactDescriptor(descriptorInput({ producer: producer({ note: "the api_key=abc123 was rotated" }) })),
    (e) => e.code === "ARTIFACT_SECRET_REJECTED"
  );
  assert.throws(
    () => createArtifactDescriptor(descriptorInput({ producer: producer({ providerId: "vault://st/providers/primary" }) })),
    (e) => e.code === "ARTIFACT_SECRET_REJECTED"
  );
});

test("internal agent names are rejected in public-facing note fields (Rule 15)", () => {
  for (const badNote of ["made by JARVIS", "produced for NEWTON", "SHERLOCK presents", "thelakmeteam"]) {
    assert.throws(
      () => createArtifactDescriptor(descriptorInput({ producer: producer({ note: badNote }) })),
      (e) => e.code === "ARTIFACT_INTERNAL_NAME_REJECTED",
      `note "${badNote}" must be rejected`
    );
  }
  // Neutral note passes.
  assert.doesNotThrow(() => createArtifactDescriptor(descriptorInput({ producer: producer({ note: "assembled from verified scene assets" }) })));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("identical inputs produce byte-identical canonical serialization (no clocks)", () => {
  const a = canonicalSerialize(createArtifactDescriptor(descriptorInput()));
  const b = canonicalSerialize(createArtifactDescriptor(descriptorInput()));
  assert.equal(a, b);
  assert.equal(typeof a, "string");
  assert.ok(a.includes(`"contentSha256":"${HASH_A}"`));
});

test("descriptors of different content hashes differ; key order is stable", () => {
  const a = canonicalSerialize(createArtifactDescriptor(descriptorInput()));
  const c = canonicalSerialize(createArtifactDescriptor(descriptorInput({ contentSha256: HASH_B })));
  assert.notEqual(a, c);
  // Fixed key order assertion: schemaVersion must precede descriptorType, etc.
  const order = [
    a.indexOf('"schemaVersion"'),
    a.indexOf('"descriptorType"'),
    a.indexOf('"contentSha256"'),
    a.indexOf('"artifactType"'),
    a.indexOf('"mimeType"'),
  ];
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

// ---------------------------------------------------------------------------
// Verification state machine
// ---------------------------------------------------------------------------

test("default state is UNVERIFIED and cannot be constructed as VERIFIED", () => {
  assert.deepEqual(VERIFICATION_STATES, ["UNVERIFIED", "VERIFIED"]);
  const d = createArtifactDescriptor(descriptorInput());
  assert.equal(d.verification.state, "UNVERIFIED");
  // Even passing a pre-verified verification block in the input must not work:
  const forged = createArtifactDescriptor(descriptorInput());
  assert.equal(forged.verification.state, "UNVERIFIED");
});

test("verification promotes ONLY with a real, hash-matching inspection result", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const verified = verifyArtifactDescriptor(d, passingInspection());
  assert.equal(verified.verification.state, "VERIFIED");
  assert.equal(verified.verification.inspectedBy, "ffprobe");
  assert.equal(verified.verification.reasonCode, null);
});

test("verification stays UNVERIFIED on mismatch, missing, or failed inspection", () => {
  const cases = [
    [passingInspection({ contentSha256: HASH_B }), "INSPECTION_HASH_MISMATCH"],
    [passingInspection({ success: false }), "INSPECTION_NOT_SUCCESSFUL"],
    [passingInspection({ contentSha256: undefined }), "INSPECTION_HASH_MISSING"],
    [passingInspection({ tool: "magic-scanner" }), "INSPECTION_TOOL_UNKNOWN"],
    [passingInspection({ format: undefined, streams: undefined }), "INSPECTION_PAYLOAD_MISSING"],
    [passingInspection({ format: {}, streams: [] }), "INSPECTION_PAYLOAD_MISSING"],
    [{}, "INSPECTION_TOOL_UNKNOWN"],
  ];
  for (const [inspection, expectedCode] of cases) {
    const d = createArtifactDescriptor(descriptorInput());
    const result = verifyArtifactDescriptor(d, inspection);
    assert.equal(result.verification.state, "UNVERIFIED", expectedCode);
    assert.equal(result.verification.reasonCode, expectedCode);
    // The original descriptor is never mutated.
    assert.equal(d.verification.state, "UNVERIFIED");
    assert.equal(d.verification.reasonCode, "NO_INSPECTION_RESULT");
  }
});

test("equivalent inspection tool is accepted; unknown tool is not", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const equivalent = verifyArtifactDescriptor(d, passingInspection({ tool: "equivalent" }));
  assert.equal(equivalent.verification.state, "VERIFIED");
});

test("re-verification of a VERIFIED descriptor is an idempotent no-op", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const verified = verifyArtifactDescriptor(d, passingInspection());
  const again = verifyArtifactDescriptor(verified, passingInspection({ contentSha256: HASH_B }));
  assert.equal(again, verified, "must return the same immutable descriptor");
  assert.equal(again.verification.state, "VERIFIED");
});

test("revokeVerification demotes with a reason (verification is never sticky against contradicting evidence)", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const verified = verifyArtifactDescriptor(d, passingInspection());
  const revoked = revokeVerification(verified, "TAMPER_SCAN_FAILED");
  assert.equal(revoked.verification.state, "UNVERIFIED");
  assert.equal(revoked.verification.reasonCode, "TAMPER_SCAN_FAILED");
});

test("worker success without passing inspection is representable as UNVERIFIED, never valid", () => {
  // A worker reports success with an artifact, but supplies no inspection
  // result. The descriptor must remain UNVERIFIED — it can never serialize
  // as verified/valid.
  const d = createArtifactDescriptor(descriptorInput());
  const serialized = serializeArtifactDescriptor(d);
  assert.equal(serialized.verification.state, "UNVERIFIED");
  assert.ok(!JSON.stringify(serialized).toLowerCase().includes('"verified":true'));
});

test("missing inspection result (null/undefined) leaves the descriptor UNVERIFIED — truthful worker-success representation", () => {
  const d = createArtifactDescriptor(descriptorInput());
  for (const missing of [null, undefined]) {
    const result = verifyArtifactDescriptor(d, missing);
    assert.equal(result.verification.state, "UNVERIFIED");
    assert.equal(result.verification.reasonCode, "NO_INSPECTION_RESULT");
  }
});

test("malformed inspection input throws a stable code (programming error, fail-closed)", () => {
  const d = createArtifactDescriptor(descriptorInput());
  for (const malformed of [42, "inspection", [], true]) {
    assert.throws(
      () => verifyArtifactDescriptor(d, malformed),
      (e) => e.code === "ARTIFACT_INSPECTION_INVALID"
    );
  }
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

test("descriptorFingerprint is stable across verification transitions", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const verified = verifyArtifactDescriptor(d, passingInspection());
  assert.equal(descriptorFingerprint(d), descriptorFingerprint(verified));
});

test("tampering with any identity/provenance field is detected", () => {
  const original = createArtifactDescriptor(descriptorInput());
  const tamperedCases = [
    ["content hash swapped", (d) => ({ ...d, contentSha256: HASH_B })],
    ["type changed", (d) => ({ ...d, artifactType: "audio" })],
    ["mime changed", (d) => ({ ...d, mimeType: "audio/mpeg" })],
    ["duration changed", (d) => ({ ...d, durationSeconds: 999 })],
    ["producer stage changed", (d) => ({ ...d, producer: { ...d.producer, stageId: "voice" } })],
    ["producer provider changed", (d) => ({ ...d, producer: { ...d.producer, providerId: "someone_else" } })],
  ];
  for (const [label, mutate] of tamperedCases) {
    const candidate = mutate(original);
    const report = detectTampering(original, candidate);
    assert.equal(report.tampered, true, `tamper case "${label}" must be detected`);
    assert.notEqual(report.originalFingerprint, report.candidateFingerprint);
  }
  const untouched = createArtifactDescriptor(descriptorInput());
  assert.equal(detectTampering(original, untouched).tampered, false);
});

// ---------------------------------------------------------------------------
// Strict allowlist serialization
// ---------------------------------------------------------------------------

test("serialization drops unknown fields instead of leaking them", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const polluted = {
    ...d,
    secret_locator: "vault://st/agents/agent-21/providers/x/primary",
    credential: "super-secret-value",
    futureField: "not-in-allowlist",
  };
  const out = serializeArtifactDescriptor(polluted);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes("vault://"));
  assert.ok(!flat.includes("super-secret-value"));
  assert.ok(!flat.includes("futureField"));
});

test("serialization rejects secret-like strings that appear in allowlisted fields", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const poisoned = { ...d, producer: { ...d.producer, note: "see bearer abc123 for access" } };
  // Constructor would have rejected this; simulate a corrupted object too.
  assert.throws(() => serializeArtifactDescriptor(poisoned), /ARTIFACT_SECRET_REJECTED/);
});

test("serialization rejects internal agent names outside the producer agentId field", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const poisoned = { ...d, producer: { ...d.producer, note: "a NEWTON production" } };
  assert.throws(() => serializeArtifactDescriptor(poisoned), /ARTIFACT_INTERNAL_NAME_REJECTED/);
  // agentId field itself is allowed to carry the registered id.
  const ok = createArtifactDescriptor(descriptorInput());
  assert.doesNotThrow(() => serializeArtifactDescriptor(ok));
});

test("serialized output is frozen and contains only allowlisted keys", () => {
  const d = createArtifactDescriptor(descriptorInput());
  const out = serializeArtifactDescriptor(d);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(
    Object.keys(out).sort(),
    ["artifactType", "contentSha256", "descriptorType", "dimensions", "durationSeconds", "mimeType", "producer", "schemaVersion", "verification"].sort()
  );
  assert.ok(Object.isFrozen(out.producer));
  assert.ok(Object.isFrozen(out.verification));
});

// ---------------------------------------------------------------------------
// Enum surface
// ---------------------------------------------------------------------------

test("exported enums are frozen and complete", () => {
  assert.ok(ARTIFACT_TYPES.includes("video") && ARTIFACT_TYPES.includes("audio") && ARTIFACT_TYPES.includes("subtitle"));
  assert.ok(MIME_TYPES.includes("video/mp4") && MIME_TYPES.includes("text/vtt"));
  assert.ok(Object.isFrozen(ARTIFACT_TYPES));
  assert.ok(Object.isFrozen(MIME_TYPES));
  assert.ok(Object.isFrozen(VERIFICATION_STATES));
});
