import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_ASSET_TYPE,
  AUDIO_SELECTION_TYPE,
  AUDIO_LICENSE_STATES,
  SELECTABLE_LICENSE_STATES,
  AUDIO_MIX_ROLES,
  declareAudioAsset,
  computeAudioAssetId,
  verifyAudioAsset,
  selectAudioAsset,
  verifyAudioSelection,
  computeAudioSelectionId,
  detectAudioTampering,
  serializeAudioRecord,
} from "../src/media/audioAssetRegistry.js";

function asset(overrides = {}) {
  return declareAudioAsset({
    agentId: "agent-01",
    assetKey: "monsoon-rain-loop-01",
    kind: "ambient",
    sourceProviderId: "lib-free-sfx-01",
    sourceDescription: "CC0 rain loop recorded from the free library provider",
    licenseState: "license_documented_cc0",
    licenseNote: "CC0 1.0 declaration recorded at intake",
    descriptiveTags: ["rain", "monsoon", "night"],
    ...overrides,
  });
}

function selection(a, overrides = {}) {
  return selectAudioAsset({
    asset: a,
    agentId: "agent-01",
    role: "bgm",
    productionRunId: "run-001-x",
    renderedArtifactRef: `sha256:${"a".repeat(64)}`,
    ...overrides,
  });
}

test("license enum: only license_documented_* states are selectable", () => {
  assert.deepEqual(
    SELECTABLE_LICENSE_STATES,
    AUDIO_LICENSE_STATES.filter((state) => state.startsWith("license_documented_")),
  );
  assert.equal(SELECTABLE_LICENSE_STATES.includes("undocumented"), false);
  assert.equal(SELECTABLE_LICENSE_STATES.includes("prohibited"), false);
});

test("declarations validate bounded fields with deterministic recomputed ids", () => {
  const a = asset();
  const b = asset();
  assert.equal(a.assetType, AUDIO_ASSET_TYPE);
  assert.match(a.assetId, /^[0-9a-f]{64}$/);
  assert.equal(a.assetId, b.assetId);
  assert.equal(computeAudioAssetId(a), a.assetId);
  assert.equal(verifyAudioAsset(a).ok, true);
  // unknown fields fail closed
  assert.throws(() => asset({ filePayload: "AAAA" }), /AUDIO_ASSET_FIELD_UNKNOWN/);
  assert.throws(() => asset({ filePath: "/media/song.mp3" }), /AUDIO_ASSET_FIELD_UNKNOWN/);
  // no payload/path/url field can even be expressed
  assert.equal(Object.keys(a).some((key) => /path|payload|url|data/i.test(key)), false);
  // invalid shapes
  assert.throws(() => asset({ agentId: "agent-999" }), /AUDIO_AGENT_INVALID/);
  assert.throws(() => asset({ kind: "audiobook" }), /AUDIO_ASSET_KIND_INVALID/);
  assert.throws(() => asset({ licenseState: "probably_fine" }), /AUDIO_LICENSE_STATE_INVALID/);
  assert.throws(() => asset({ sourceProviderId: "p" }), /AUDIO_PROVIDER_INVALID/);
  assert.throws(() => asset({ assetKey: "track with vault://kms/key" }), /AUDIO_SECRET_REJECTED/);
  assert.throws(() => asset({ sourceDescription: "voiced by LAKME" }), /AUDIO_INTERNAL_NAME_REJECTED/);
  assert.throws(() => asset({ descriptiveTags: Array.from({ length: 11 }, () => "tag") }), /AUDIO_TAG_INVALID/);
});

test("selection fails closed for non-documented license states (fresh declarations)", () => {
  for (const state of ["undocumented", "unknown", "prohibited"]) {
    assert.throws(
      () => selection(asset({ assetKey: `x-${state}-1`, licenseState: state })),
      /AUDIO_LICENSE_NOT_DOCUMENTED/,
    );
  }
  for (const state of SELECTABLE_LICENSE_STATES) {
    const ok = selection(asset({ assetKey: `ok-${state.replace(/_/g, "-")}`.slice(0, 40), licenseState: state }));
    assert.equal(verifyAudioSelection(ok).ok, true);
  }
});

test("selection fails closed on cross-Director use", () => {
  const a = asset();
  assert.throws(() => selection(a, { agentId: "agent-02" }), /AUDIO_SCOPE_MISMATCH/);
  assert.equal(verifyAudioSelection(selection(a)).ok, true);
});

test("selection validates role, run, and artifact-ref shapes", () => {
  const a = asset();
  assert.throws(() => selection(a, { role: "narration" }), /AUDIO_ROLE_INVALID/);
  assert.throws(() => selection(a, { renderedArtifactRef: "/path/file.mp3" }), /AUDIO_ARTIFACT_REF_INVALID/);
  assert.throws(() => selection(a, { renderedArtifactRef: "sha256:zz" }), /AUDIO_ARTIFACT_REF_INVALID/);
  assert.throws(() => selection(a, { agentId: "agent-999" }), /AUDIO_AGENT_INVALID/);
  // renderedArtifactRef is optional
  const bare = selectAudioAsset({ asset: a, agentId: "agent-01", role: "sfx", productionRunId: "run-001-x" });
  assert.equal(bare.renderedArtifactRef, null);
  assert.deepEqual(AUDIO_MIX_ROLES, ["voice", "bgm", "sfx"]);
});

test("selections and declarations are deterministic with tamper detection", () => {
  const a = asset();
  const s1 = selection(a);
  const s2 = selection(a);
  assert.equal(s1.selectionType, AUDIO_SELECTION_TYPE);
  assert.equal(s1.selectionId, s2.selectionId);
  assert.equal(computeAudioSelectionId(s1), s1.selectionId);
  assert.equal(detectAudioTampering(a, asset()).tampered, false);
  assert.equal(detectAudioTampering(a, asset({ licenseNote: "changed" })).tampered, true);
  assert.equal(detectAudioTampering(s1, selection(a, { role: "sfx" })).tampered, true);
  // integrity gates surface tampering truthfully
  assert.equal(verifyAudioAsset({ ...a, licenseState: "undocumented" }).reasonCode, "AUDIO_ASSET_TAMPERED");
  assert.equal(verifyAudioSelection({ ...s1, role: "sfx" }).reasonCode, "AUDIO_SELECTION_TAMPERED");
  assert.equal(verifyAudioAsset({ assetType: "other" }).reasonCode, "AUDIO_ASSET_MALFORMED");
});

test("serialization is a strict allowlist; polluted fields can never leak", () => {
  const a = asset();
  const s = selection(a);
  const outA1 = serializeAudioRecord(a);
  const outA2 = serializeAudioRecord(a);
  assert.equal(JSON.stringify(outA1), JSON.stringify(outA2));
  assert.deepEqual(Object.keys(outA1), [
    "assetType",
    "assetId",
    "agentId",
    "assetKey",
    "kind",
    "sourceProviderId",
    "sourceDescription",
    "licenseState",
    "licenseNote",
    "descriptiveTags",
  ]);
  const outS = serializeAudioRecord(s);
  assert.deepEqual(Object.keys(outS), [
    "selectionType",
    "selectionId",
    "agentId",
    "assetId",
    "role",
    "productionRunId",
    "renderedArtifactRef",
  ]);
  assert.equal(Object.isFrozen(outA1), true);
  assert.equal(Object.isFrozen(outS), true);
  // polluted keys are dropped (no leak)
  const polluted = serializeAudioRecord({ ...a, credentialLocator: "vault://kms/x", filePayload: "not expressible anyway" });
  assert.equal(JSON.stringify(polluted).includes("vault://"), false);
  assert.equal(JSON.stringify(polluted).includes("filePayload"), false);
  // tampered records cannot serialize
  assert.throws(() => serializeAudioRecord({ ...a, licenseState: "undocumented" }), /AUDIO_ASSET_TAMPERED/);
  // a record that is neither a valid selection nor a valid asset fails closed
  assert.throws(() => serializeAudioRecord({ selectionType: "other" }), /AUDIO_ASSET_MALFORMED/);
});
