/**
 * ST Production House — real TTS execution worker (Issue #177, Module 32 —
 * media pipeline: from voice profile + script to real verified audio).
 *
 * S-M32-01 (ttsAdapter.js) defines the free-first tier chain, persistent
 * voice profiles, and truthful outcomes. S-M30-01 (artifactDescriptor.js)
 * anchors artifact identity to content hashes. The S-M30 runner (Issue #170)
 * performs real inspections. Until now NO component actually EXECUTED
 * text-to-speech. This module is the worker boundary:
 *
 *   voice profile (tts_voice_profile_v1) + script
 *     └── executeTtsGeneration()
 *           ├── verifyVoiceProfile()          — tamper gate (S-M32-01)
 *           ├── selectTtsProvider()           — contract tier chain, quota-aware
 *           ├── buildEdgeTtsArgs/buildPiperArgs — ARRAY ARGS ONLY (Rule 2)
 *           ├── runTtsProvider()              — injectable spawn, no shell
 *           ├── inspectMediaFile()            — real bytes → hash + ffprobe (#170)
 *           ├── verifyArtifactDescriptor()    — S-M30-01 promotion
 *           └── recordTtsGenerationOutcome()  — S-M32-01 truthful outcome
 *
 * Honesty contract (AGENTS.md Rules 1–3, 35):
 *   - Provider routing follows the FIXED free-first chain from the frozen
 *     S-M32-01 tier order. Only DECLARED capabilities from an injected
 *     registry (the governed provider catalog: edge-tts, piper) are
 *     selectable; a language/voice the declaration does not claim is never
 *     chosen. A registry slot marked quota-exhausted is skipped; when no
 *     provider remains, the durable WAITING_FOR_QUOTA state is returned —
 *     never a disguised failure or a fabricated success.
 *   - Credential-reference flow (Rule 17): a provider whose catalog
 *     authType is not "none" requires a broker-issued opaque locator in its
 *     registry slot (CREDENTIAL_MISSING otherwise). This module never sees,
 *     logs, or serializes raw key material; the production transport
 *     resolves locator → credential outside this boundary.
 *   - A provider call that merely exits 0 is NOT evidence of audio. Media
 *     state derives EXCLUSIVELY from real verification: the written file is
 *     hashed from its actual bytes and probed by ffprobe, and only a
 *     matching-hash inspection promotes the descriptor (S-M30-01), which
 *     alone produces mediaStatus "verified" / generationMode
 *     "provider_generated" in the S-M32-01 outcome.
 *   - Every failure is truthful and stable-coded: PROVIDER_UNAVAILABLE,
 *     TTS_TIMEOUT, PROVIDER_CALL_FAILED, CREDENTIAL_MISSING,
 *     QUOTA_EXHAUSTED (→ WAITING_FOR_QUOTA), LANGUAGE_UNSUPPORTED,
 *     VOICE_UNSUPPORTED, TTS_OUTPUT_PATH_UNSAFE, INSPECTION_FAILED.
 *   - Transports are injectable (`spawnImpl`, `readFileImpl`, clock) so the
 *     test suite proves the contract offline; production binds
 *     node:child_process spawn (array args, shell:false) and node:fs/promises.
 *   - No secrets serialized (R17); internal agent names never serialize
 *     (R15); no new status states (R5); no new dependencies.
 */

import { isValidLocator } from "../broker/locator.js";
import {
  TTS_PROVIDER_TIERS,
  computeTtsOutcomeId,
  recordTtsGenerationOutcome,
} from "./ttsAdapter.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "./artifactDescriptor.js";
import { inspectMediaFile, validateArtifactPath } from "./mediaInspectionRunner.js";

export const TTS_EXECUTOR_VERSION = "tts_executor_v1";

/** Stable error codes (fail-closed). */
export const TTS_EXECUTOR_ERROR_CODES = Object.freeze([
  "TTS_PROFILE_INVALID",
  "TTS_PROFILE_TAMPERED",
  "TTS_SCRIPT_INVALID",
  "TTS_OUTPUT_PATH_UNSAFE",
  "LANGUAGE_UNSUPPORTED",
  "VOICE_UNSUPPORTED",
  "CREDENTIAL_MISSING",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "TTS_TIMEOUT",
  "PROVIDER_CALL_FAILED",
  "TTS_SPAWN_FAILED",
  "INSPECTION_FAILED",
]);

/**
 * The contract free-first chain (S-M32-01 order) bound to the governed
 * provider catalog. Tier 1–3 are approved free network providers; tier 4 is
 * the local open-source emergency provider. ElevenLabs is an owner-side
 * catalog entry for LIVE usage and is deliberately NOT here: the automatic
 * production chain never routes to a paid provider (Rule 35).
 */
export const TTS_PROVIDER_CHAIN = Object.freeze([
  Object.freeze({
    providerId: "edge-tts",
    providerRole: "approved_free_primary",
    tier: 1,
    command: "edge-tts",
    authType: "none",
  }),
  Object.freeze({
    providerId: "piper",
    providerRole: "local_open_source_emergency",
    tier: 4,
    command: "piper",
    authType: "none",
  }),
]);

const DEFAULT_TTS_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_STDERR_TAIL = 2000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stderrTail(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  return text.length === 0 ? null : text.slice(-MAX_STDERR_TAIL);
}

/**
 * Validate a TTS output path BEFORE deriving any argv from it. Shape check
 * only; mirrors the media-layer path rules.
 */
export function validateTtsOutputPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw fail("TTS_OUTPUT_PATH_UNSAFE");
  }
  if (path.includes("\0")) throw fail("TTS_OUTPUT_PATH_UNSAFE");
  if (path.startsWith("-")) throw fail("TTS_OUTPUT_PATH_UNSAFE");
  if (path.split("/").some((segment) => segment === "..")) throw fail("TTS_OUTPUT_PATH_UNSAFE");
  return path;
}

/**
 * Validate narration text before it becomes execution input. The S-M32-01
 * clean-text rules apply (bounded, secret-shaped and internal agent names
 * rejected — R15/R17).
 */
export function validateNarrationText(text) {
  if (typeof text !== "string") throw fail("TTS_SCRIPT_INVALID");
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_TEXT_LENGTH) {
    throw fail("TTS_SCRIPT_INVALID");
  }
  if (/password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i.test(normalized)) {
    throw fail("TTS_SCRIPT_INVALID");
  }
  if (/\b(?:jarvis|sherlock|lakme|panchi|veda|byte|chanakya|kabir|shakti|rohan|maya|aarohi|vikram|tara|ananya|karan|dev|aanya|arjun|nisha|newton)\b/i.test(normalized)) {
    throw fail("TTS_SCRIPT_INVALID");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Provider selection: contract tier chain, capability- and quota-aware
// ---------------------------------------------------------------------------

/**
 * Select the highest-priority provider that can serve this request.
 *
 *   registry: providerId → {
 *     declared,                 — declareTtsProviderCapabilities() output
 *     quotaExhausted?: boolean, — truthful durable quota state, if known
 *     credentialLocator?,       — opaque broker locator for non-"none" authType
 *     command?,                 — override the default binary name (tests)
 *   }
 *
 * Selection rules (fail-closed):
 *   - Unknown providerId in the chain entry (not in registry) → skip.
 *   - quotaExhausted === true → skip (quota-aware fallback).
 *   - declared.languages must include the requested language, and the
 *     requested voiceId must be declared — otherwise skip (never claim a
 *     capability the provider did not declare).
 *   - authType !== "none" requires a valid opaque locator — else skip with
 *     CREDENTIAL_MISSING recorded; if NO selectable provider remains because
 *     of credentials only, the request is WAITING_FOR_QUOTA-honest: the
 *     owner must onboard credentials (a distinct truth from provider quota,
 *     surfaced via attempts[].failureCode CREDENTIAL_MISSING).
 *   - First surviving chain entry wins (contract order, never reordered).
 */
export function selectTtsProvider({ language, voiceId, registry }) {
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) {
    throw fail("PROVIDER_UNAVAILABLE");
  }
  const attempts = [];
  for (const chainEntry of TTS_PROVIDER_CHAIN) {
    const slot = registry[chainEntry.providerId];
    if (slot === undefined || slot === null) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "PROVIDER_UNAVAILABLE" });
      continue;
    }
    if (slot.quotaExhausted === true) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "QUOTA_EXHAUSTED" });
      continue;
    }
    const declared = slot.declared;
    if (declared === undefined || declared === null) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "PROVIDER_UNAVAILABLE" });
      continue;
    }
    const languages = Array.isArray(declared.languages) ? declared.languages : [];
    if (!languages.includes(language)) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "LANGUAGE_UNSUPPORTED" });
      continue;
    }
    const voices = Array.isArray(declared.voices) ? declared.voices : [];
    if (!voices.some((voice) => voice && voice.voiceId === voiceId)) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "VOICE_UNSUPPORTED" });
      continue;
    }
    if (chainEntry.authType !== "none" && (slot.credentialLocator === undefined || !isValidLocator(slot.credentialLocator))) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "CREDENTIAL_MISSING" });
      continue;
    }
    return Object.freeze({
      selected: true,
      providerId: chainEntry.providerId,
      providerRole: chainEntry.providerRole,
      tier: chainEntry.tier,
      command: typeof slot.command === "string" && slot.command.length > 0 ? slot.command : chainEntry.command,
      credentialLocator: chainEntry.authType !== "none" ? slot.credentialLocator : null,
      attempts: Object.freeze([...attempts, Object.freeze({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: null })]),
    });
  }
  return Object.freeze({ selected: false, attempts: Object.freeze(attempts.map((a) => Object.freeze(a))) });
}

// ---------------------------------------------------------------------------
// Pure argument construction (CONVENTIONS Rule 2: array args ONLY)
// ---------------------------------------------------------------------------

/**
 * Edge-TTS command line as a frozen array:
 *   edge-tts --voice <voiceId> --text <text> --write-media <outputPath>
 */
export function buildEdgeTtsArgs({ voiceId, text, outputPath }) {
  return Object.freeze([
    "--voice", voiceId,
    "--text", text,
    "--write-media", outputPath,
  ]);
}

/**
 * Piper reads narration from STDIN (spawn contract carries `stdin`) and
 * writes audio to --output_file. Frozen array; text never on argv.
 *   piper --model <modelPath> --output_file <outputPath>
 */
export function buildPiperArgs({ outputPath, modelPath = "piper-voice" }) {
  validateArtifactPath(modelPath);
  return Object.freeze(["--model", modelPath, "--output_file", outputPath]);
}

/**
 * Build the spawn request for a selected provider. Pure; array args only;
 * the output path is validated before any argv is derived.
 */
export function buildTtsSpawnRequest({ providerId, voiceId, text, outputPath, registry }) {
  validateTtsOutputPath(outputPath);
  const narration = validateNarrationText(text);
  if (providerId === "edge-tts") {
    return Object.freeze({
      command: "edge-tts",
      args: buildEdgeTtsArgs({ voiceId, text: narration, outputPath }),
      stdin: null,
    });
  }
  if (providerId === "piper") {
    const slot = registry && typeof registry === "object" ? registry.piper : undefined;
    const modelPath = slot && typeof slot.modelPath === "string" && slot.modelPath.length > 0 ? slot.modelPath : "piper-voice";
    return Object.freeze({
      command: "piper",
      args: buildPiperArgs({ outputPath, modelPath }),
      stdin: narration,
    });
  }
  throw fail("PROVIDER_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// Execution (injectable spawn; honest failure codes)
// ---------------------------------------------------------------------------

/**
 * Run one TTS provider invocation.
 *
 *   spawnImpl: ({ command, args, timeoutMs, stdin }) => Promise<{
 *     exitCode: number, stdout: string, stderr: string, timedOut?: boolean
 *   }> — production wraps node:child_process spawn (array args, shell:false,
 *   stdin write when present, timeout kill).
 */
export async function runTtsProvider(request, { spawnImpl, timeoutMs = DEFAULT_TTS_TIMEOUT_MS } = {}) {
  if (!request || typeof request !== "object" || !Array.isArray(request.args) || request.args.length === 0) {
    throw fail("TTS_SPAWN_FAILED");
  }
  if (typeof request.command !== "string" || request.command.length === 0) {
    throw fail("TTS_SPAWN_FAILED");
  }
  if (typeof spawnImpl !== "function") throw fail("TTS_SPAWN_FAILED");
  let result;
  try {
    result = await spawnImpl({ command: request.command, args: request.args, timeoutMs, stdin: request.stdin ?? null });
  } catch {
    throw fail("PROVIDER_UNAVAILABLE");
  }
  if (!result || typeof result !== "object") throw fail("TTS_SPAWN_FAILED");
  if (result.timedOut === true) throw fail("TTS_TIMEOUT");
  if (typeof result.exitCode !== "number") throw fail("TTS_SPAWN_FAILED");
  if (result.exitCode !== 0) {
    const error = fail("PROVIDER_CALL_FAILED");
    error.exitCode = result.exitCode;
    error.stderrTail = stderrTail(result.stderr);
    throw error;
  }
  return Object.freeze({ exitCode: 0, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" });
}

// ---------------------------------------------------------------------------
// Orchestration: the honest end-to-end result
// ---------------------------------------------------------------------------

/**
 * Execute one TTS generation end to end.
 *
 * Options:
 *   scriptText     — REQUIRED narration text (validated before use)
 *   outputPath     — REQUIRED destination of the audio file
 *   registry       — REQUIRED provider registry (declared capabilities)
 *   spawnImpl      — REQUIRED for real execution
 *   readFileImpl   — REQUIRED for post-generation inspection (real bytes)
 *   probeSpawnImpl — optional distinct spawn for ffprobe (defaults spawnImpl)
 *   timeoutMs / probeTimeoutMs / now — injectable bounds + clock
 *   skipPreflight  — internal/testing escape hatch; default pre-flights
 *
 * Returns a frozen, honest record. success === true ONLY when a provider in
 * the contract chain really ran, the written audio was really hashed + probed
 * (matching its own bytes), and the S-M32-01 outcome reflects VERIFIED
 * evidence. quotaState WAITING_FOR_QUOTA is returned when no provider can
 * serve the request (quota or missing credentials) — never a fake success.
 */
export async function executeTtsGeneration(voiceProfile, options = {}) {
  const base = {
    executorVersion: TTS_EXECUTOR_VERSION,
    success: false,
    agentId: null,
    voiceProfileId: null,
    outputPath: null,
    language: null,
    voiceId: null,
    attempts: Object.freeze([]),
    providerCall: null,
    inspection: null,
    outcome: null,
    descriptor: null,
    quotaState: null,
    mediaStatus: "unverified",
    generationMode: "not_evidenced",
    failureCode: null,
  };

  // 1. Profile integrity gate (S-M32-01) — tampered profiles never execute.
  try {
    if (typeof voiceProfile !== "object" || voiceProfile === null || Array.isArray(voiceProfile)) {
      throw fail("TTS_PROFILE_INVALID");
    }
    const { verifyVoiceProfile } = await import("./ttsAdapter.js");
    const verdict = verifyVoiceProfile(voiceProfile);
    if (verdict.ok === false) {
      throw fail(verdict.reasonCode === "TTS_PROFILE_TAMPERED" ? "TTS_PROFILE_TAMPERED" : "TTS_PROFILE_INVALID");
    }
    if (!voiceProfile.provider || typeof voiceProfile.provider !== "object") {
      throw fail("TTS_PROFILE_INVALID");
    }
  } catch (err) {
    return deepFreeze({ ...base, failureCode: err.code ?? "TTS_PROFILE_INVALID" });
  }

  const withProfile = deepFreeze({
    ...base,
    agentId: voiceProfile.agentId,
    voiceProfileId: voiceProfile.voiceProfileId,
    language: voiceProfile.language,
    voiceId: voiceProfile.provider.voiceId,
  });

  // 2. Options + output path.
  let opts;
  try {
    opts = options === null || typeof options !== "object" || Array.isArray(options) ? null : options;
    if (!opts) throw fail("TTS_SCRIPT_INVALID");
    if (opts.scriptText === undefined || opts.outputPath === undefined || opts.registry === undefined) {
      throw fail("TTS_SCRIPT_INVALID");
    }
    validateTtsOutputPath(opts.outputPath);
  } catch (err) {
    return deepFreeze({ ...withProfile, failureCode: err.code });
  }
  const withOutput = deepFreeze({ ...withProfile, outputPath: opts.outputPath });

  // 3. Provider selection along the contract chain (quota- and capability-
  //    aware). Selection uses the profile's provider as the REQUIRED voice/
  //    language target; the chain supplies the execution route.
  const language = voiceProfile.language ?? "en";
  const voiceId = voiceProfile.provider.voiceId;
  let selection;
  try {
    selection = selectTtsProvider({ language, voiceId, registry: opts.registry });
  } catch (err) {
    return deepFreeze({ ...withOutput, failureCode: err.code });
  }

  if (selection.selected !== true) {
    // No provider can serve the request. Distinguish the two honest waiting
    // truths: credential absence (owner gate) vs provider quota.
    const credentialBlocked = selection.attempts.some((a) => a.skipped === "CREDENTIAL_MISSING");
    const quotaBlocked = selection.attempts.some((a) => a.skipped === "QUOTA_EXHAUSTED");
    const failureCode = credentialBlocked && !quotaBlocked ? "CREDENTIAL_MISSING" : "QUOTA_EXHAUSTED";
    return deepFreeze({
      ...withOutput,
      attempts: selection.attempts,
      quotaState: "WAITING_FOR_QUOTA",
      failureCode,
    });
  }

  const withSelection = deepFreeze({
    ...withOutput,
    attempts: selection.attempts,
    providerCall: Object.freeze({
      providerId: selection.providerId,
      providerRole: selection.providerRole,
      callStatus: "succeeded",
    }),
  });

  // 4. Build argv + execute the real provider call.
  let request;
  let execution;
  try {
    request = buildTtsSpawnRequest({
      providerId: selection.providerId,
      voiceId,
      text: opts.scriptText,
      outputPath: opts.outputPath,
      registry: opts.registry,
    });
    const effectiveSpawn = typeof selection.command === "string" && selection.command.length > 0 && selection.command !== request.command
      ? (spawnOpts) => opts.spawnImpl({ ...spawnOpts, command: selection.command })
      : opts.spawnImpl;
    if (typeof effectiveSpawn !== "function") throw fail("TTS_SPAWN_FAILED");
    execution = await runTtsProvider(request, { spawnImpl: effectiveSpawn, timeoutMs: opts.timeoutMs });
  } catch (err) {
    const code = err.code ?? "TTS_SPAWN_FAILED";
    const callStatus = code === "QUOTA_EXHAUSTED" ? "quota_exhausted" : "failed";
    return deepFreeze({
      ...withSelection,
      providerCall: Object.freeze({ providerId: selection.providerId, providerRole: selection.providerRole, callStatus }),
      failureCode: code,
      ...(err.stderrTail ? { stderrTail: err.stderrTail } : {}),
    });
  }

  // 5. Real verification of the written audio (Issue #170): real bytes →
  //    real hash + real ffprobe. The provider's exit 0 is NOT evidence.
  const now = typeof opts.now === "function" ? opts.now : () => new Date();
  const probeSpawn = opts.probeSpawnImpl ?? opts.spawnImpl;
  const inspection = await inspectMediaFile(opts.outputPath, {
    readFileImpl: opts.readFileImpl,
    spawnImpl: probeSpawn ? (probeOpts) => probeSpawn({ ...probeOpts, command: "ffprobe" }) : undefined,
    timeoutMs: opts.probeTimeoutMs,
    now,
  });

  const withInspection = {
    ...withSelection,
    inspection,
  };

  // 6. Descriptor + truthful outcome (S-M30-01 + S-M32-01). The descriptor
  //    is created from the REAL measured hash — no claimed duration is
  //    asserted. callStatus stays "succeeded" only because the command ran;
  //    mediaStatus/generationMode derive from verification alone.
  let descriptor = null;
  let outcome = null;
  if (inspection.success === true) {
    descriptor = createArtifactDescriptor({
      artifactType: "audio",
      mimeType: "audio/mpeg",
      contentSha256: inspection.contentSha256,
      producer: {
        agentId: voiceProfile.agentId,
        runId: typeof opts.productionRunId === "string" ? opts.productionRunId : "tts-executor",
        stageId: "tts",
        providerId: selection.providerId,
      },
      createdAt: now().toISOString(),
    });
    const verifiedDescriptor = verifyArtifactDescriptor(descriptor, inspection);
    outcome = recordTtsGenerationOutcome({
      voiceProfile,
      descriptor: verifiedDescriptor,
      providerCall: { providerId: selection.providerId, providerRole: selection.providerRole, status: "succeeded" },
    });
    return deepFreeze({
      ...withInspection,
      descriptor: verifiedDescriptor,
      outcome,
      quotaState: outcome.quotaState,
      mediaStatus: outcome.mediaStatus,
      generationMode: outcome.generationMode,
      success: outcome.mediaStatus === "verified" && outcome.generationMode === "provider_generated",
      failureCode: outcome.mediaStatus === "verified" ? null : "INSPECTION_FAILED",
    });
  }

  // 7. Inspection failed: truthful failure, outcome recorded against an
  //    UNVERIFIED descriptor so the evidence trail stays honest.
  try {
    descriptor = createArtifactDescriptor({
      artifactType: "audio",
      mimeType: "audio/mpeg",
      contentSha256: "0".repeat(64),
      producer: {
        agentId: voiceProfile.agentId,
        runId: typeof opts.productionRunId === "string" ? opts.productionRunId : "tts-executor",
        stageId: "tts",
        providerId: selection.providerId,
      },
      createdAt: now().toISOString(),
    });
    outcome = recordTtsGenerationOutcome({
      voiceProfile,
      descriptor,
      providerCall: { providerId: selection.providerId, providerRole: selection.providerRole, status: "succeeded" },
    });
  } catch {
    outcome = null;
  }
  return deepFreeze({
    ...withInspection,
    outcome,
    quotaState: "OK",
    mediaStatus: "unverified",
    generationMode: "not_evidenced",
    success: false,
    failureCode: "INSPECTION_FAILED",
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Re-exported so callers can verify outcome integrity without importing the
// contract module directly (identity anchor over recorded evidence).
export { computeTtsOutcomeId };

// Contract tier chain passthrough for routing introspection.
export { TTS_PROVIDER_TIERS };
