import test from "node:test";
import assert from "node:assert/strict";
import {
  declareTtsProviderCapabilities,
  recordTtsGenerationOutcome,
  resolveTtsQuotaState,
  serializeTtsOutcomeForDashboard,
  serializeVoiceProfileForDashboard,
  createVoiceProfile,
  verifyTtsOutcome,
  verifyVoiceProfile,
  ttsProviderChain,
  TTS_CALL_STATUSES,
  TTS_PROVIDER_TIERS,
} from "../src/media/ttsAdapter.js";
import {
  createArtifactDescriptor,
  verifyArtifactDescriptor,
  descriptorFingerprint,
} from "../src/media/artifactDescriptor.js";

const JARVIS = "agent-01";
const NEWTON = "agent-21";

const AUDIO_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function audioDescriptor(overrides = {}) {
  return createArtifactDescriptor({
    contentSha256: AUDIO_HASH,
    artifactType: "audio",
    mimeType: "audio/mpeg",
    producer: {
      agentId: JARVIS,
      runId: "run-tts-1",
      stageId: "voice",
      providerId: "edge-tts-class",
    },
    ...overrides,
  });
}

function realInspection(hash = AUDIO_HASH) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: hash,
    format: { duration: "12.5", format_name: "mp3" },
    streams: [{ codec_type: "audio" }],
    inspectedAt: "2026-09-16T00:00:00.000Z",
  };
}

function voiceProfile(overrides = {}) {
  return createVoiceProfile({
    agentId: JARVIS,
    provider: {
      providerId: "edge-tts-class",
      providerRole: "approved_free_primary",
      modelIdentifier: "tts-1",
      voiceId: "hi-IN-male-01",
    },
    language: "hi",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Provider tiers (fixed free-first chain)
// ---------------------------------------------------------------------------

test("provider chain is the fixed free-first order with no paid fallback", () => {
  assert.deepEqual(ttsProviderChain(), [
    { tier: 1, role: "approved_free_primary" },
    { tier: 2, role: "approved_free_secondary" },
    { tier: 3, role: "approved_free_tertiary" },
    { tier: 4, role: "local_open_source_emergency" },
  ]);
  assert.equal(Object.isFrozen(TTS_PROVIDER_TIERS), true);
  for (const status of ["paid_fallback", "rotation_account", "enterprise"]) {
    assert.throws(() => createVoiceProfile({
      agentId: JARVIS,
      provider: {
        providerId: "paid-provider",
        providerRole: status,
        modelIdentifier: "m",
        voiceId: "v",
      },
    }), /TTS_PROVIDER_ROLE_INVALID/, `${status} must never be a valid role`);
  }
});

// ---------------------------------------------------------------------------
// 2. Capability declaration
// ---------------------------------------------------------------------------

test("capability declaration is a claim, deterministic and frozen", () => {
  const caps = declareTtsProviderCapabilities({
    adapterId: "edge-tts-class-adapter",
    languages: ["hi", "en", "hi"],
    voices: [
      { voiceId: "hi-IN-male-01", language: "hi", supportsEmotion: true },
      { voiceId: "en-US-female-01", language: "en" },
    ],
    supportsEmotion: true,
    supportsRate: true,
    supportsPitch: true,
    rateBounds: { min: 0.5, max: 2 },
    pitchBounds: { min: -20, max: 20 },
  });
  assert.equal(caps.capabilitiesType, "tts_provider_capabilities_v1");
  assert.match(caps.capabilitiesId, /^[a-f0-9]{64}$/);
  assert.deepEqual([...caps.languages], ["en", "hi"]);
  assert.equal(caps.voices.length, 2);
  assert.equal(Object.isFrozen(caps), true);

  const again = declareTtsProviderCapabilities({
    adapterId: "edge-tts-class-adapter",
    languages: ["en", "hi"],
    voices: [
      { voiceId: "hi-IN-male-01", language: "hi", supportsEmotion: true },
      { voiceId: "en-US-female-01", language: "en" },
    ],
    supportsEmotion: true,
    supportsRate: true,
    supportsPitch: true,
    rateBounds: { min: 0.5, max: 2 },
    pitchBounds: { min: -20, max: 20 },
  });
  assert.equal(again.capabilitiesId, caps.capabilitiesId);
});

test("malformed capability declarations fail closed", () => {
  assert.throws(() => declareTtsProviderCapabilities(null), /TTS_CAPABILITY_INVALID/);
  assert.throws(() => declareTtsProviderCapabilities({}), /TTS_ADAPTER_ID_INVALID/);
  assert.throws(
    () => declareTtsProviderCapabilities({ adapterId: "x", languages: [], voices: [{ voiceId: "v", language: "en" }] }),
    /TTS_LANGUAGE_INVALID/,
  );
  assert.throws(
    () => declareTtsProviderCapabilities({ adapterId: "x", languages: ["en"], voices: [] }),
    /TTS_VOICE_INVALID/,
  );
  assert.throws(
    () => declareTtsProviderCapabilities({
      adapterId: "x",
      languages: ["e"],
      voices: [{ voiceId: "v", language: "en" }],
    }),
    /TTS_LANGUAGE_INVALID/,
  );
  assert.throws(
    () => declareTtsProviderCapabilities({
      adapterId: "x",
      languages: ["en"],
      voices: [{ voiceId: "v", language: "en" }],
      rateBounds: { min: 2, max: 0.5 },
    }),
    /TTS_BOUNDS_INVALID/,
  );
});

// ---------------------------------------------------------------------------
// 3. Voice continuity profiles
// ---------------------------------------------------------------------------

test("voice profile binds director/character to provider and delivery config", () => {
  const profile = voiceProfile();
  assert.equal(profile.profileType, "tts_voice_profile_v1");
  assert.equal(profile.agentId, JARVIS);
  assert.equal(profile.provider.providerId, "edge-tts-class");
  assert.equal(profile.provider.providerRole, "approved_free_primary");
  assert.equal(profile.language, "hi");
  assert.equal(profile.emotion, "neutral");
  assert.match(profile.voiceProfileId, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(profile), true);
});

test("profile is deterministic per director and character, and distinct across them", () => {
  const a = voiceProfile();
  const b = voiceProfile();
  assert.equal(a.voiceProfileId, b.voiceProfileId);
  const character = voiceProfile({ characterId: "narrator_main" });
  assert.notEqual(a.voiceProfileId, character.voiceProfileId);
  const newton = voiceProfile({ agentId: NEWTON });
  assert.notEqual(a.voiceProfileId, newton.voiceProfileId);
  const emotion = voiceProfile({ emotion: "dark" });
  assert.notEqual(a.voiceProfileId, emotion.voiceProfileId);
});

test("profiles never carry secret material (Rule 17)", () => {
  // A vault locator fails the provider-id shape check first (still fail-closed).
  assert.throws(() => voiceProfile({
    provider: {
      providerId: "vault://st/secrets/tts-key",
      providerRole: "approved_free_primary",
      modelIdentifier: "m",
      voiceId: "v",
    },
  }), /TTS_PROVIDER_INVALID/);
  assert.throws(() => voiceProfile({
    provider: {
      providerId: "p1-provider",
      providerRole: "approved_free_primary",
      modelIdentifier: "m api_key=abcd",
      voiceId: "v",
    },
  }), /TTS_SECRET_REJECTED/);
});

test("profile free text rejects internal agent names (Rule 15)", () => {
  assert.throws(() => voiceProfile({ characterId: "the jarvis narrator" }), /TTS_INTERNAL_NAME_REJECTED/);
});

test("malformed profiles fail closed with stable codes", () => {
  assert.throws(() => createVoiceProfile({ agentId: "JARVIS" }), /TTS_AGENT_INVALID/);
  assert.throws(() => createVoiceProfile({ agentId: "agent-99" }), /TTS_AGENT_INVALID/);
  assert.throws(() => voiceProfile({ language: "zzzzzzzzzzz" }), /TTS_LANGUAGE_INVALID/);
  assert.throws(() => voiceProfile({ speakingRate: 12 }), /TTS_RATE_INVALID/);
  assert.throws(() => voiceProfile({ pitch: -99 }), /TTS_PITCH_INVALID/);
  assert.throws(() => voiceProfile({ emotion: "screaming" }), /TTS_EMOTION_INVALID/);
  assert.throws(() => voiceProfile({
    pronunciationProfile: [{ match: "x", replaceWith: "" }],
  }), /TTS_PRONUNCIATION_INVALID/);
  assert.throws(() => createVoiceProfile({
    agentId: JARVIS,
    provider: { providerId: "prov", providerRole: "not_a_role", modelIdentifier: "m", voiceId: "v" },
  }), /TTS_PROVIDER_ROLE_INVALID/);
});

test("profile verification detects tampering and never mutates", () => {
  const profile = voiceProfile();
  assert.deepEqual(verifyVoiceProfile(profile), { ok: true });
  const tampered = { ...profile, emotion: "calm" };
  assert.deepEqual(verifyVoiceProfile(tampered), { ok: false, reasonCode: "TTS_PROFILE_TAMPERED" });
  assert.deepEqual(verifyVoiceProfile(null), { ok: false, reasonCode: "TTS_PROFILE_MALFORMED" });
  assert.deepEqual(verifyVoiceProfile({ profileType: "other" }), { ok: false, reasonCode: "TTS_PROFILE_MALFORMED" });
});

// ---------------------------------------------------------------------------
// 4. Generation outcomes — the fail-closed core
// ---------------------------------------------------------------------------

test("provider call success without real inspection stays unverified (not_evidenced)", () => {
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.mediaStatus, "unverified");
  assert.equal(outcome.generationMode, "not_evidenced");
  assert.equal(outcome.descriptorVerificationState, "UNVERIFIED");
  assert.equal(outcome.quotaState, "OK");
  assert.deepEqual(outcome.publication, { status: "not_requested" });
  assert.match(outcome.outcomeId, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(outcome), true);
});

test("real matching inspection promotes to verified/provider_generated", () => {
  const descriptor = verifyArtifactDescriptor(audioDescriptor(), realInspection());
  assert.equal(descriptor.verification.state, "VERIFIED");
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.mediaStatus, "verified");
  assert.equal(outcome.generationMode, "provider_generated");
});

test("quota exhaustion maps to WAITING_FOR_QUOTA — never success", () => {
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "quota_exhausted" },
  });
  assert.equal(outcome.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(outcome.mediaStatus, "unverified");
  assert.equal(outcome.generationMode, "not_evidenced");
  assert.equal(resolveTtsQuotaState("quota_exhausted"), "WAITING_FOR_QUOTA");
  assert.equal(resolveTtsQuotaState("succeeded"), "OK");
  assert.equal(resolveTtsQuotaState("failed"), "OK");
  assert.throws(() => resolveTtsQuotaState("magic_success"), /TTS_PROVIDER_CALL_INVALID/);
  assert.deepEqual([...TTS_CALL_STATUSES], ["succeeded", "failed", "quota_exhausted"]);
});

test("hash mismatch keeps the descriptor unverified and the outcome not_evidenced", () => {
  const descriptor = verifyArtifactDescriptor(audioDescriptor(), realInspection(OTHER_HASH));
  assert.equal(descriptor.verification.state, "UNVERIFIED");
  assert.equal(descriptor.verification.reasonCode, "INSPECTION_HASH_MISMATCH");
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.generationMode, "not_evidenced");
});

test("failed provider calls are recorded honestly, never as success", () => {
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "failed" },
  });
  assert.equal(outcome.provider.callStatus, "failed");
  assert.equal(outcome.mediaStatus, "unverified");
});

// ---------------------------------------------------------------------------
// 5. Fail-closed scope and forgery rejection
// ---------------------------------------------------------------------------

test("outcome is Director-scoped: cross-director descriptors fail closed", () => {
  const newtonDescriptor = audioDescriptor({
    producer: {
      agentId: NEWTON,
      runId: "run-tts-1",
      stageId: "voice",
      providerId: "edge-tts-class",
    },
  });
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: newtonDescriptor,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_AGENT_SCOPE_MISMATCH/);
});

test("provider mismatch between profile and call fails closed", () => {
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "piper-local", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_PROVIDER_MISMATCH/);
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "local_open_source_emergency", status: "succeeded" },
  }), /TTS_PROVIDER_MISMATCH/);
});

test("hand-forged verification blocks are rejected", () => {
  const forged = {
    ...audioDescriptor(),
    verification: { state: "VERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: null },
  };
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: forged,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_DESCRIPTOR_INVALID/);

  const forgedTool = {
    ...audioDescriptor(),
    verification: { state: "VERIFIED", inspectedBy: "imagination", inspectedAt: "2026-01-01T00:00:00Z", reasonCode: null },
  };
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: forgedTool,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_DESCRIPTOR_INVALID/);
});

test("non-audio or malformed descriptors fail closed", () => {
  const imageDescriptor = createArtifactDescriptor({
    contentSha256: AUDIO_HASH,
    artifactType: "image",
    mimeType: "image/png",
    producer: { agentId: JARVIS, runId: "r", stageId: "s", providerId: "p" },
  });
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: imageDescriptor,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_DESCRIPTOR_INVALID/);
  assert.throws(() => recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: null,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  }), /TTS_DESCRIPTOR_INVALID/);
});

// ---------------------------------------------------------------------------
// 6. Determinism and outcome tamper detection
// ---------------------------------------------------------------------------

test("identical inputs produce identical outcomes; different inputs diverge", () => {
  const args = {
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  };
  const a = recordTtsGenerationOutcome(args);
  const b = recordTtsGenerationOutcome(args);
  assert.equal(a.outcomeId, b.outcomeId);
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  const verified = verifyArtifactDescriptor(audioDescriptor(), realInspection());
  const promoted = recordTtsGenerationOutcome({ ...args, descriptor: verified });
  assert.notEqual(a.outcomeId, promoted.outcomeId);
});

test("outcome verification detects tampering", () => {
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.deepEqual(verifyTtsOutcome(outcome), { ok: true });
  const tampered = { ...outcome, mediaStatus: "verified" };
  assert.deepEqual(verifyTtsOutcome(tampered), { ok: false, reasonCode: "TTS_OUTCOME_TAMPERED" });
  const fakeSuccess = { ...outcome, generationMode: "provider_generated" };
  assert.equal(verifyTtsOutcome(fakeSuccess).ok, false);
  assert.deepEqual(verifyTtsOutcome(null), { ok: false, reasonCode: "TTS_OUTCOME_MALFORMED" });
});

test("outcome id binds the descriptor fingerprint", () => {
  const descriptor = audioDescriptor();
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor,
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.descriptorFingerprint, descriptorFingerprint(descriptor));
});

// ---------------------------------------------------------------------------
// 7. Strict-allowlist serialization (Rule 17)
// ---------------------------------------------------------------------------

test("dashboard serialization projects only allowlisted fields", () => {
  const outcome = recordTtsGenerationOutcome({
    voiceProfile: voiceProfile(),
    descriptor: audioDescriptor(),
    providerCall: { providerId: "edge-tts-class", providerRole: "approved_free_primary", status: "succeeded" },
  });
  const polluted = { ...outcome, credentialLocator: "vault://st/secrets/tts", debug: true };
  const dto = serializeTtsOutcomeForDashboard(polluted);
  assert.deepEqual(Object.keys(dto), [
    "outcomeType",
    "outcomeId",
    "agentId",
    "voiceProfileId",
    "descriptorVerificationState",
    "provider",
    "quotaState",
    "mediaStatus",
    "generationMode",
    "publicationStatus",
  ]);
  assert.equal("credentialLocator" in dto, false);
  assert.equal(Object.isFrozen(dto), true);
  assert.throws(() => serializeTtsOutcomeForDashboard({ ...outcome, outcomeId: "x" }), /TTS_OUTCOME_TAMPERED/);
  assert.throws(() => serializeTtsOutcomeForDashboard(null), /TTS_OUTCOME_MALFORMED/);
});

test("voice-profile serialization never exposes credential material", () => {
  const dto = serializeVoiceProfileForDashboard(voiceProfile({
    pronunciationProfile: [{ match: "Shiva", replaceWith: "Shi-va" }],
  }));
  assert.deepEqual(Object.keys(dto), [
    "profileType",
    "voiceProfileId",
    "agentId",
    "characterId",
    "provider",
    "language",
    "speakingRate",
    "pitch",
    "emotion",
  ]);
  assert.equal("pronunciationProfile" in dto, false);
  assert.equal(Object.isFrozen(dto), true);
  assert.throws(() => serializeVoiceProfileForDashboard({ ...voiceProfile(), agentId: "agent-99" }), /TTS_PROFILE_TAMPERED/);
});
