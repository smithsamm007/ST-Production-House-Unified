import test from "node:test";
import assert from "node:assert/strict";
import {
  PACKAGE_DESTINATIONS,
  PACKAGE_PROFILE_MANIFEST_TYPE,
  PACKAGE_PROFILES,
  buildPackageProfileManifest,
  computePackageProfileManifestId,
  listPackageProfiles,
  resolvePackageProfile,
  resolvePackageProfileForAgent,
  serializePackageProfileForDashboard,
  verifyPackageProfileManifest,
} from "../src/jarvis/packageProfileManifest.js";

const JARVIS = "agent-01";
const NEWTON = "agent-21";

// ---------------------------------------------------------------------------
// 1. Profile registry (additive, frozen)
// ---------------------------------------------------------------------------

test("profile registry exposes exactly the canonical default and the JARVIS legacy profile", () => {
  const ids = listPackageProfiles().map((p) => p.profileId);
  assert.deepEqual(ids, ["canonical_default_v1", "jarvis_legacy_v1"]);
  for (const key of Object.keys(PACKAGE_PROFILES)) {
    assert.equal(Object.isFrozen(PACKAGE_PROFILES[key]), true, `${key} must be frozen`);
  }
  const canonical = PACKAGE_PROFILES.canonical_default_v1;
  assert.equal(canonical.longFormCount, 1);
  assert.equal(canonical.standaloneShortCount, 2);
  assert.equal(canonical.promoReelCount, 1);
  const legacy = PACKAGE_PROFILES.jarvis_legacy_v1;
  assert.equal(legacy.longFormCount, 1);
  assert.equal(legacy.standaloneShortCount, 3, "JARVIS legacy contract keeps 3 standalone Shorts");
  assert.equal(legacy.promoReelCount, 1);
  assert.deepEqual([...legacy.standaloneShortRoles], ["opening_hook", "high_tension_moment", "cliffhanger_teaser"]);
});

test("destination allowlist matches the canonical platform matrix", () => {
  assert.deepEqual([...PACKAGE_DESTINATIONS], [
    "youtube",
    "bilibili",
    "youtube_shorts",
    "instagram_reels",
    "facebook_reels",
    "snapchat_spotlight",
  ]);
});

// ---------------------------------------------------------------------------
// 2. Profile resolution (additive; JARVIS legacy preserved by default)
// ---------------------------------------------------------------------------

test("JARVIS resolves to its legacy 3-Shorts profile and every other agent to the canonical default", () => {
  assert.equal(resolvePackageProfileForAgent(JARVIS), "jarvis_legacy_v1");
  assert.equal(resolvePackageProfileForAgent(NEWTON), "canonical_default_v1");
  assert.equal(resolvePackageProfileForAgent("agent-02"), "canonical_default_v1");
});

test("unknown or malformed agent ids fail closed", () => {
  assert.throws(() => resolvePackageProfileForAgent("agent-99"), /PACKAGE_PROFILE_AGENT_INVALID/);
  assert.throws(() => resolvePackageProfileForAgent("JARVIS"), /PACKAGE_PROFILE_AGENT_INVALID/);
  assert.throws(() => resolvePackageProfileForAgent(undefined), /PACKAGE_PROFILE_AGENT_INVALID/);
  assert.throws(() => resolvePackageProfileForAgent(null), /PACKAGE_PROFILE_AGENT_INVALID/);
});

test("profile resolution fails closed for unknown profile ids", () => {
  assert.throws(() => resolvePackageProfile("super_shorts"), /PACKAGE_PROFILE_UNKNOWN/);
  assert.throws(() => resolvePackageProfile(42), /PACKAGE_PROFILE_UNKNOWN/);
  assert.equal(resolvePackageProfile(undefined).profileId, "canonical_default_v1");
  assert.equal(resolvePackageProfile("jarvis_legacy_v1").profileId, "jarvis_legacy_v1");
});

// ---------------------------------------------------------------------------
// 3. Manifest construction — canonical default profile
// ---------------------------------------------------------------------------

test("canonical manifest encodes exactly 1 long-form + 2 Shorts + 1 promo Reel with correct destinations", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "pkg_newton_001" });
  assert.equal(manifest.manifestType, PACKAGE_PROFILE_MANIFEST_TYPE);
  assert.equal(manifest.profileId, "canonical_default_v1");
  assert.equal(manifest.agentId, NEWTON);
  assert.equal(manifest.longFormCount, 1);
  assert.equal(manifest.standaloneShortCount, 2);
  assert.equal(manifest.promoReelCount, 1);
  assert.equal(manifest.outputs.length, 4);

  const longForm = manifest.outputs.find((o) => o.kind === "long_form_episode");
  assert.deepEqual(longForm.destinations, ["youtube", "bilibili"], "long-form is YouTube + Bilibili ONLY");
  assert.equal(longForm.slot, "long_form_1");
  assert.deepEqual(longForm.runtimeBoundsSeconds, { min: 1800, max: 3000 }, "30–50 minutes");

  const shorts = manifest.outputs.filter((o) => o.kind === "standalone_short");
  assert.equal(shorts.length, 2);
  const promo = manifest.outputs.find((o) => o.kind === "promotional_reel");
  assert.equal(promo.slot, "promo_reel_1");
  for (const output of [...shorts, promo]) {
    assert.deepEqual(output.destinations, [
      "youtube_shorts",
      "instagram_reels",
      "facebook_reels",
      "snapchat_spotlight",
    ]);
  }
});

test("JARVIS legacy manifest preserves the existing 3-Shorts planner contract", () => {
  const manifest = buildPackageProfileManifest({ agentId: JARVIS });
  assert.equal(manifest.profileId, "jarvis_legacy_v1");
  assert.equal(manifest.standaloneShortCount, 3);
  const slots = manifest.outputs.filter((o) => o.kind === "standalone_short").map((o) => o.slot);
  assert.deepEqual(slots, ["standalone_short_1", "standalone_short_2", "standalone_short_3"]);
  const roles = manifest.outputs
    .filter((o) => o.kind === "standalone_short")
    .map((o) => o.targetSeconds);
  assert.deepEqual(roles, [30, 45, 30]);
});

test("explicit profileId override wins over agent-default resolution", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON, profileId: "jarvis_legacy_v1" });
  assert.equal(manifest.profileId, "jarvis_legacy_v1");
  assert.equal(manifest.standaloneShortCount, 3);
});

test("publication is always not_requested and no media/provider state is claimed", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON });
  assert.deepEqual(manifest.publication, { status: "not_requested" });
  assert.equal(manifest.mediaStatus, "not_generated");
  assert.deepEqual(manifest.providerCalls, []);
});

test("manifest is frozen and manifest id is a recomputed SHA-256", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifest.manifestId, computePackageProfileManifestId(manifest));
  assert.match(manifest.manifestId, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------

test("identical inputs produce byte-identical manifests (no clocks, no randomness)", () => {
  const a = buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "pkg_1", concept: "How Wi-Fi works" });
  const b = buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "pkg_1", concept: "How Wi-Fi works" });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.manifestId, b.manifestId);
});

test("different inputs produce different manifest ids", () => {
  const a = buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "pkg_1" });
  const b = buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "pkg_2" });
  assert.notEqual(a.manifestId, b.manifestId);
  const c = buildPackageProfileManifest({ agentId: JARVIS, packageTaskId: "pkg_1" });
  assert.notEqual(a.manifestId, c.manifestId);
});

// ---------------------------------------------------------------------------
// 5. Fail-closed input validation (Rules 15/17)
// ---------------------------------------------------------------------------

test("malformed inputs fail closed with stable codes", () => {
  assert.throws(() => buildPackageProfileManifest(null), /PACKAGE_PROFILE_INPUT_INVALID/);
  assert.throws(() => buildPackageProfileManifest([]), /PACKAGE_PROFILE_INPUT_INVALID/);
  assert.throws(() => buildPackageProfileManifest("x"), /PACKAGE_PROFILE_INPUT_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "" }), /PACKAGE_PROFILE_TASK_ID_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: 42 }), /PACKAGE_PROFILE_TASK_ID_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, packageTaskId: "x".repeat(121) }), /PACKAGE_PROFILE_TASK_ID_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, concept: "ab" }), /PACKAGE_PROFILE_CONCEPT_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, concept: "x".repeat(1201) }), /PACKAGE_PROFILE_CONCEPT_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, concept: 7 }), /PACKAGE_PROFILE_CONCEPT_INVALID/);
  assert.throws(() => buildPackageProfileManifest({ agentId: NEWTON, profileId: "unknown" }), /PACKAGE_PROFILE_UNKNOWN/);
});

test("secret-like free text is rejected (Rule 17)", () => {
  assert.throws(
    () => buildPackageProfileManifest({ agentId: NEWTON, concept: "explain api_key rotation" }),
    /PACKAGE_PROFILE_SECRET_REJECTED/,
  );
  assert.throws(
    () => buildPackageProfileManifest({ agentId: NEWTON, concept: "video about vault://st/secrets/x" }),
    /PACKAGE_PROFILE_SECRET_REJECTED/,
  );
});

test("internal agent names never leak into free text (Rule 15)", () => {
  assert.throws(
    () => buildPackageProfileManifest({ agentId: NEWTON, concept: "a story featuring JARVIS" }),
    /PACKAGE_PROFILE_INTERNAL_AGENT_NAME_REJECTED/,
  );
  assert.throws(
    () => buildPackageProfileManifest({ agentId: NEWTON, concept: "the newton guide" }),
    /PACKAGE_PROFILE_INTERNAL_AGENT_NAME_REJECTED/,
  );
});

// ---------------------------------------------------------------------------
// 6. Tamper detection
// ---------------------------------------------------------------------------

test("verifyPackageProfileManifest accepts genuine manifests and rejects tampering", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON });
  assert.deepEqual(verifyPackageProfileManifest(manifest), { ok: true });

  const tamperedOutputs = { ...manifest, outputs: manifest.outputs.slice(0, 3) };
  assert.deepEqual(verifyPackageProfileManifest(tamperedOutputs), {
    ok: false,
    reasonCode: "MANIFEST_ID_MISMATCH",
  });

  const tamperedCounts = { ...manifest, standaloneShortCount: 99 };
  assert.equal(verifyPackageProfileManifest(tamperedCounts).ok, false);

  const tamperedDestinations = {
    ...manifest,
    outputs: manifest.outputs.map((o, i) =>
      i === 0 ? { ...o, destinations: ["instagram_reels"] } : o,
    ),
  };
  assert.equal(verifyPackageProfileManifest(tamperedDestinations).ok, false);

  const tamperedPublication = { ...manifest, publication: { status: "approved" } };
  assert.equal(verifyPackageProfileManifest(tamperedPublication).ok, false);

  const tamperedMedia = { ...manifest, mediaStatus: "generated" };
  assert.equal(verifyPackageProfileManifest(tamperedMedia).ok, false);

  assert.deepEqual(verifyPackageProfileManifest(null), {
    ok: false,
    reasonCode: "PACKAGE_PROFILE_MANIFEST_MALFORMED",
  });
  assert.deepEqual(verifyPackageProfileManifest({ manifestType: "other", manifestId: "x" }), {
    ok: false,
    reasonCode: "PACKAGE_PROFILE_MANIFEST_MALFORMED",
  });
});

test("verify never mutates or throws on mismatch", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON });
  const snapshot = JSON.stringify(manifest);
  const tampered = { ...manifest, profileId: "jarvis_legacy_v1" };
  assert.equal(verifyPackageProfileManifest(tampered).ok, false);
  assert.equal(JSON.stringify(manifest), snapshot);
  assert.equal(JSON.stringify(tampered), JSON.stringify({ ...manifest, profileId: "jarvis_legacy_v1" }));
});

// ---------------------------------------------------------------------------
// 7. Strict-allowlist serialization (Rule 17)
// ---------------------------------------------------------------------------

test("dashboard serialization projects only allowlisted fields and drops unknown ones", () => {
  const manifest = buildPackageProfileManifest({
    agentId: NEWTON,
    packageTaskId: "pkg_x",
    concept: "How glass is made",
  });
  const polluted = {
    ...manifest,
    secretLocator: "vault://st/secrets/provider-key",
    internalNotes: "do not ship",
  };
  const dto = serializePackageProfileForDashboard(polluted);
  assert.equal(Object.isFrozen(dto), true);
  assert.deepEqual(Object.keys(dto), [
    "manifestType",
    "manifestId",
    "profileId",
    "agentId",
    "packageTaskId",
    "outputs",
    "longFormCount",
    "standaloneShortCount",
    "promoReelCount",
    "mediaStatus",
    "publicationStatus",
  ]);
  assert.equal("secretLocator" in dto, false);
  assert.equal("internalNotes" in dto, false);
  assert.equal("concept" in dto, false, "free text is not exposed on the dashboard DTO");
  assert.equal(dto.publicationStatus, "not_requested");
  assert.equal(dto.mediaStatus, "not_generated");
});

test("serialization re-validates identity and rejects tampered or secret-bearing manifests", () => {
  const manifest = buildPackageProfileManifest({ agentId: NEWTON });
  assert.throws(() => serializePackageProfileForDashboard({ ...manifest, outputs: [] }), /MANIFEST_ID_MISMATCH/);
  assert.throws(() => serializePackageProfileForDashboard(null), /PACKAGE_PROFILE_MANIFEST_MALFORMED/);
  // Tampered fields are caught by the integrity gate BEFORE field validation.
  const badAgent = { ...buildPackageProfileManifest({ agentId: NEWTON }), agentId: "agent-99" };
  assert.throws(() => serializePackageProfileForDashboard(badAgent), /MANIFEST_ID_MISMATCH/);
  const badProfile = { ...buildPackageProfileManifest({ agentId: NEWTON }), profileId: "made_up" };
  assert.throws(() => serializePackageProfileForDashboard(badProfile), /MANIFEST_ID_MISMATCH/);
});
