/**
 * ST Production House — real visual generation execution worker (Issue #180,
 * Module 35 — media pipeline: from style profile + scene-plan reference to
 * real verified visual media).
 *
 * S-M35-01 (visualAdapter.js) defines the free-first tier chain, persistent
 * Director-scoped style/continuity profiles, path-free scene-plan-bound
 * requests, and truthful outcomes. S-M30-01 (artifactDescriptor.js) anchors
 * artifact identity to content hashes. The S-M30 runner (Issue #170) performs
 * real inspections. Until now NO component actually EXECUTED visual
 * generation. This module is the worker boundary:
 *
 *   style profile (visual_style_profile_v1) + generation request
 *     └── executeVisualGeneration()
 *           ├── verifyVisualStyleProfile()   — tamper gate (S-M35-01)
 *           ├── verifyVisualRequest() id     — tamper gate on the request id
 *           ├── selectVisualProvider()       — contract tier chain, quota-aware
 *           ├── buildDiffusersArgs/buildFfmpegFrameArgs — ARRAY ARGS (Rule 2)
 *           ├── runVisualProvider()          — injectable spawn, no shell
 *           ├── inspectMediaFile()           — real bytes → hash + ffprobe (#170)
 *           ├── verifyArtifactDescriptor()   — S-M30-01 promotion
 *           └── recordVisualGenerationOutcome() — S-M35-01 truthful outcome
 *
 * Honesty contract (AGENTS.md Rules 1–3):
 *   - Provider routing follows the FIXED free-first chain from the frozen
 *     S-M35-01 tier order. Only DECLARED capabilities from an injected
 *     registry are selectable; a modality/aspect-ratio the declaration does
 *     not claim is never chosen. A registry slot marked quota-exhausted is
 *     skipped; when no provider remains, the durable WAITING_FOR_QUOTA state
 *     is returned — never a disguised failure or a fabricated success.
 *   - Credential-reference flow (Rule 17): a provider whose chain entry
 *     authType is not "none" requires a broker-issued opaque locator in its
 *     registry slot (CREDENTIAL_MISSING otherwise). This module never sees,
 *     logs, or serializes raw key material; the production transport resolves
 *     locator → credential outside this boundary.
 *   - A provider call that merely exits 0 is NOT evidence of media. Media
 *     state derives EXCLUSIVELY from real verification: the written file is
 *     hashed from its actual bytes and probed by ffprobe, and only a
 *     matching-hash inspection promotes the descriptor (S-M30-01), which
 *     alone produces mediaStatus "verified" / generationMode
 *     "provider_generated" in the S-M35-01 outcome.
 *   - Every failure is truthful and stable-coded: PROVIDER_UNAVAILABLE,
 *     VISUAL_TIMEOUT, PROVIDER_CALL_FAILED, CREDENTIAL_MISSING,
 *     QUOTA_EXHAUSTED (→ WAITING_FOR_QUOTA), VISUAL_OUTPUT_PATH_UNSAFE,
 *     VISUAL_PROMPT_INVALID, INSPECTION_FAILED.
 *   - Transports are injectable (`spawnImpl`, `readFileImpl`, clock) so the
 *     test suite proves the contract offline; production binds
 *     node:child_process spawn (array args, shell:false) and node:fs/promises.
 *   - No secrets serialized (R17); internal agent names never serialize
 *     (R15); no new status states (R5); no new dependencies.
 */

import { isValidLocator } from "../broker/locator.js";
import {
  VISUAL_PROVIDER_TIERS,
  computeVisualOutcomeId,
  computeVisualRequestId,
  recordVisualGenerationOutcome,
  verifyVisualStyleProfile,
} from "./visualAdapter.js";
import {
  createArtifactDescriptor,
  verifyArtifactDescriptor,
} from "./artifactDescriptor.js";
import { inspectMediaFile, validateArtifactPath } from "./mediaInspectionRunner.js";

export const VISUAL_EXECUTOR_VERSION = "visual_executor_v1";

/** Stable error codes (fail-closed). */
export const VISUAL_EXECUTOR_ERROR_CODES = Object.freeze([
  "VISUAL_PROFILE_INVALID",
  "VISUAL_PROFILE_TAMPERED",
  "VISUAL_REQUEST_INVALID",
  "VISUAL_REQUEST_TAMPERED",
  "VISUAL_PROMPT_INVALID",
  "VISUAL_OUTPUT_PATH_UNSAFE",
  "VISUAL_MODALITY_INVALID",
  "CREDENTIAL_MISSING",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "VISUAL_TIMEOUT",
  "PROVIDER_CALL_FAILED",
  "VISUAL_SPAWN_FAILED",
  "INSPECTION_FAILED",
]);

/**
 * The contract free-first chain (S-M35-01 order) bound to concrete open
 * execution routes. Tier 1–3 are approved free network providers; tier 4 is
 * the local open-source emergency provider. Paid image/video services are
 * deliberately NOT here: the automatic production chain never routes to a
 * paid provider.
 */
export const VISUAL_PROVIDER_CHAIN = Object.freeze([
  Object.freeze({
    providerId: "pollinations",
    providerRole: "approved_free_primary",
    tier: 1,
    command: "visual-pollinations",
    authType: "none",
    modalities: ["image", "still_acquisition"],
  }),
  Object.freeze({
    providerId: "local-sd",
    providerRole: "local_open_source_emergency",
    tier: 4,
    command: "visual-local",
    authType: "none",
    modalities: ["image", "still_acquisition", "video_clip", "animation"],
  }),
]);

const DEFAULT_VISUAL_TIMEOUT_MS = 300_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 4_000;
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
 * Validate a visual output path BEFORE deriving any argv from it. Shape
 * check only; mirrors the media-layer path rules.
 */
export function validateVisualOutputPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw fail("VISUAL_OUTPUT_PATH_UNSAFE");
  }
  if (path.includes("\0")) throw fail("VISUAL_OUTPUT_PATH_UNSAFE");
  if (path.startsWith("-")) throw fail("VISUAL_OUTPUT_PATH_UNSAFE");
  if (path.split("/").some((segment) => segment === "..")) throw fail("VISUAL_OUTPUT_PATH_UNSAFE");
  return path;
}

/**
 * Validate the visual prompt before it becomes execution input. Bounded,
 * secret-shaped and internal agent names rejected (R15/R17). The normalized
 * prompt is returned; it is carried to the provider via STDIN (never argv),
 * mirroring the TTS executor's piper narration discipline.
 */
export function validateVisualPrompt(prompt) {
  if (typeof prompt !== "string") throw fail("VISUAL_PROMPT_INVALID");
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_PROMPT_LENGTH) {
    throw fail("VISUAL_PROMPT_INVALID");
  }
  if (/password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i.test(normalized)) {
    throw fail("VISUAL_PROMPT_INVALID");
  }
  if (/\b(?:jarvis|sherlock|lakme|panchi|veda|byte|chanakya|kabir|shakti|rohan|maya|aarohi|vikram|tara|ananya|karan|dev|aanya|arjun|nisha|newton)\b/i.test(normalized)) {
    throw fail("VISUAL_PROMPT_INVALID");
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
 *     declared,                 — declareVisualProviderCapabilities() output
 *     quotaExhausted?: boolean, — truthful durable quota state, if known
 *     credentialLocator?,       — opaque broker locator for non-"none" authType
 *     command?,                 — override the default binary name (tests)
 *     modelPath?,               — local model path for the emergency provider
 *   }
 *
 * Selection rules (fail-closed):
 *   - Unknown providerId in the chain entry (not in registry) → skip.
 *   - quotaExhausted === true → skip (quota-aware fallback).
 *   - declared.modalities must include the requested modality and
 *     declared.aspectRatios must include the requested aspect ratio —
 *     otherwise skip (never claim a capability the provider did not declare).
 *   - authType !== "none" requires a valid opaque locator — else skip with
 *     CREDENTIAL_MISSING recorded; if NO selectable provider remains because
 *     of credentials only, the request is honestly waiting on the owner's
 *     credential onboarding (surfaced via attempts[].failureCode
 *     CREDENTIAL_MISSING), distinct from provider quota.
 *   - First surviving chain entry wins (contract order, never reordered).
 */
export function selectVisualProvider({ modality, aspectRatio, registry }) {
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) {
    throw fail("PROVIDER_UNAVAILABLE");
  }
  const attempts = [];
  for (const chainEntry of VISUAL_PROVIDER_CHAIN) {
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
    const modalities = Array.isArray(declared.modalities) ? declared.modalities : [];
    if (!modalities.includes(modality)) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "VISUAL_MODALITY_INVALID" });
      continue;
    }
    const aspectRatios = Array.isArray(declared.aspectRatios) ? declared.aspectRatios : [];
    if (!aspectRatios.includes(aspectRatio)) {
      attempts.push({ providerId: chainEntry.providerId, providerRole: chainEntry.providerRole, skipped: "VISUAL_ASPECT_INVALID" });
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
      modalities: Object.freeze([...chainEntry.modalities]),
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
 * Pollinations command line as a frozen array. The prompt is NOT on argv —
 * the spawn contract carries it via `stdin`:
 *   visual-pollinations --modality <m> --aspect <ar> --output <path>
 *                        [--model <modelIdentifier>]
 */
export function buildPollinationsArgs({ modality, aspectRatio, outputPath, modelIdentifier }) {
  validateVisualOutputPath(outputPath);
  const args = [
    "--modality", modality,
    "--aspect", aspectRatio,
    "--output", outputPath,
  ];
  if (typeof modelIdentifier === "string" && modelIdentifier.length > 0) {
    args.push("--model", modelIdentifier);
  }
  return Object.freeze(args);
}

/**
 * Local open-source emergency provider command line. The prompt arrives via
 * STDIN (never argv); model path is a validated artifact path:
 *   visual-local --modality <m> --aspect <ar> --output <path>
 *                [--model <modelPath>] [--clip-seconds <n>]
 */
export function buildLocalVisualArgs({ modality, aspectRatio, outputPath, modelPath, clipSeconds }) {
  validateVisualOutputPath(outputPath);
  const args = [
    "--modality", modality,
    "--aspect", aspectRatio,
    "--output", outputPath,
  ];
  if (typeof modelPath === "string" && modelPath.length > 0) {
    validateArtifactPath(modelPath);
    args.push("--model", modelPath);
  }
  if (typeof clipSeconds === "number" && Number.isFinite(clipSeconds)) {
    args.push("--clip-seconds", String(clipSeconds));
  }
  return Object.freeze(args);
}

/**
 * Build the spawn request for a selected provider. Pure; array args only;
 * the prompt travels via STDIN, never argv (CONVENTIONS Rule 2 discipline
 * shared with the TTS executor).
 */
export function buildVisualSpawnRequest({ providerId, modality, aspectRatio, outputPath, prompt, registry }) {
  validateVisualOutputPath(outputPath);
  const cleanPrompt = validateVisualPrompt(prompt);
  if (providerId === "pollinations") {
    const slot = registry && typeof registry === "object" ? registry.pollinations : undefined;
    const modelIdentifier = slot && typeof slot.modelIdentifier === "string" && slot.modelIdentifier.length > 0 ? slot.modelIdentifier : undefined;
    return Object.freeze({
      command: "visual-pollinations",
      args: buildPollinationsArgs({ modality, aspectRatio, outputPath, modelIdentifier }),
      stdin: cleanPrompt,
    });
  }
  if (providerId === "local-sd") {
    const slot = registry && typeof registry === "object" ? registry["local-sd"] : undefined;
    const modelPath = slot && typeof slot.modelPath === "string" && slot.modelPath.length > 0 ? slot.modelPath : undefined;
    const clipSeconds = slot && typeof slot.clipSeconds === "number" ? slot.clipSeconds : undefined;
    return Object.freeze({
      command: "visual-local",
      args: buildLocalVisualArgs({ modality, aspectRatio, outputPath, modelPath, clipSeconds }),
      stdin: cleanPrompt,
    });
  }
  throw fail("PROVIDER_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// Execution (injectable spawn; honest failure codes)
// ---------------------------------------------------------------------------

/**
 * Run one visual provider invocation.
 *
 *   spawnImpl: ({ command, args, timeoutMs, stdin }) => Promise<{
 *     exitCode: number, stdout: string, stderr: string, timedOut?: boolean
 *   }> — production wraps node:child_process spawn (array args, shell:false,
 *   stdin write when present, timeout kill).
 */
export async function runVisualProvider(request, { spawnImpl, timeoutMs = DEFAULT_VISUAL_TIMEOUT_MS } = {}) {
  if (!request || typeof request !== "object" || !Array.isArray(request.args) || request.args.length === 0) {
    throw fail("VISUAL_SPAWN_FAILED");
  }
  if (typeof request.command !== "string" || request.command.length === 0) {
    throw fail("VISUAL_SPAWN_FAILED");
  }
  if (typeof spawnImpl !== "function") throw fail("VISUAL_SPAWN_FAILED");
  let result;
  try {
    result = await spawnImpl({ command: request.command, args: request.args, timeoutMs, stdin: request.stdin ?? null });
  } catch {
    throw fail("PROVIDER_UNAVAILABLE");
  }
  if (!result || typeof result !== "object") throw fail("VISUAL_SPAWN_FAILED");
  if (result.timedOut === true) throw fail("VISUAL_TIMEOUT");
  if (typeof result.exitCode !== "number") throw fail("VISUAL_SPAWN_FAILED");
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

/** Modality → descriptor artifactType (S-M30-01 vocabulary). */
const MODALITY_ARTIFACT_TYPE = Object.freeze({
  image: "image",
  video_clip: "video",
  animation: "video",
  still_acquisition: "image",
});

/** Modality → canonical verified MIME type. */
const MODALITY_MIME = Object.freeze({
  image: "image/png",
  video_clip: "video/mp4",
  animation: "video/mp4",
  still_acquisition: "image/jpeg",
});

/**
 * Execute one visual generation end to end.
 *
 * Options:
 *   styleProfile   — REQUIRED verified S-M35-01 profile (tamper-gated)
 *   request        — REQUIRED S-M35-01 generation request (id re-verified)
 *   prompt         — REQUIRED visual prompt text (validated; via stdin)
 *   outputPath     — REQUIRED destination of the media file
 *   registry       — REQUIRED provider registry (declared capabilities)
 *   spawnImpl      — REQUIRED for real execution
 *   readFileImpl   — REQUIRED for post-generation inspection (real bytes)
 *   probeSpawnImpl — optional distinct spawn for ffprobe (defaults spawnImpl)
 *   timeoutMs / probeTimeoutMs / now — injectable bounds + clock
 *
 * Returns a frozen, honest record. success === true ONLY when a provider in
 * the contract chain really ran, the written media was really hashed + probed
 * (matching its own bytes), and the S-M35-01 outcome reflects VERIFIED
 * evidence. quotaState WAITING_FOR_QUOTA is returned when no provider can
 * serve the request (quota or missing credentials) — never a fake success.
 */
export async function executeVisualGeneration(styleProfile, options = {}) {
  const base = {
    executorVersion: VISUAL_EXECUTOR_VERSION,
    success: false,
    agentId: null,
    visualProfileId: null,
    requestId: null,
    outputPath: null,
    modality: null,
    aspectRatio: null,
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

  // 1. Profile + request integrity gates (S-M35-01) — tampered records never
  //    execute.
  try {
    if (typeof styleProfile !== "object" || styleProfile === null || Array.isArray(styleProfile)) {
      throw fail("VISUAL_PROFILE_INVALID");
    }
    const profileVerdict = verifyVisualStyleProfile(styleProfile);
    if (profileVerdict.ok === false) {
      throw fail(profileVerdict.reasonCode === "VISUAL_PROFILE_TAMPERED" ? "VISUAL_PROFILE_TAMPERED" : "VISUAL_PROFILE_INVALID");
    }
    const request = options?.request;
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw fail("VISUAL_REQUEST_INVALID");
    }
    if (request.requestType !== "visual_generation_request_v1" || request.requestId !== computeVisualRequestId(request)) {
      throw fail("VISUAL_REQUEST_TAMPERED");
    }
    if (request.agentId !== styleProfile.agentId || request.visualProfileId !== styleProfile.visualProfileId) {
      throw fail("VISUAL_REQUEST_INVALID");
    }
    if (request.provider === null || typeof request.provider !== "object") {
      throw fail("VISUAL_REQUEST_INVALID");
    }
  } catch (err) {
    return deepFreeze({ ...base, failureCode: err.code ?? "VISUAL_PROFILE_INVALID" });
  }

  const request = options.request;
  const withProfile = deepFreeze({
    ...base,
    agentId: styleProfile.agentId,
    visualProfileId: styleProfile.visualProfileId,
    requestId: request.requestId,
    modality: request.modality,
    aspectRatio: request.aspectRatio,
  });

  // 2. Options + output path.
  let opts;
  try {
    opts = options === null || typeof options !== "object" || Array.isArray(options) ? null : options;
    if (!opts) throw fail("VISUAL_PROMPT_INVALID");
    if (opts.prompt === undefined || opts.outputPath === undefined || opts.registry === undefined) {
      throw fail("VISUAL_PROMPT_INVALID");
    }
    validateVisualOutputPath(opts.outputPath);
  } catch (err) {
    return deepFreeze({ ...withProfile, failureCode: err.code });
  }
  const withOutput = deepFreeze({ ...withProfile, outputPath: opts.outputPath });

  // 3. Provider selection along the contract chain (quota- and capability-
  //    aware). Selection uses the request's modality + aspect ratio as the
  //    REQUIRED targets; the chain supplies the execution route.
  let selection;
  try {
    selection = selectVisualProvider({ modality: request.modality, aspectRatio: request.aspectRatio, registry: opts.registry });
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
  let spawnRequest;
  let execution;
  try {
    spawnRequest = buildVisualSpawnRequest({
      providerId: selection.providerId,
      modality: request.modality,
      aspectRatio: request.aspectRatio,
      outputPath: opts.outputPath,
      prompt: opts.prompt,
      registry: opts.registry,
    });
    const effectiveSpawn = typeof selection.command === "string" && selection.command.length > 0 && selection.command !== spawnRequest.command
      ? (spawnOpts) => opts.spawnImpl({ ...spawnOpts, command: selection.command })
      : opts.spawnImpl;
    if (typeof effectiveSpawn !== "function") throw fail("VISUAL_SPAWN_FAILED");
    execution = await runVisualProvider(spawnRequest, { spawnImpl: effectiveSpawn, timeoutMs: opts.timeoutMs });
  } catch (err) {
    const code = err.code ?? "VISUAL_SPAWN_FAILED";
    const callStatus = code === "QUOTA_EXHAUSTED" ? "quota_exhausted" : "failed";
    return deepFreeze({
      ...withSelection,
      providerCall: Object.freeze({ providerId: selection.providerId, providerRole: selection.providerRole, callStatus }),
      failureCode: code,
      ...(err.stderrTail ? { stderrTail: err.stderrTail } : {}),
    });
  }

  // 5. Real verification of the written media (Issue #170): real bytes →
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

  // 6. Descriptor + truthful outcome (S-M30-01 + S-M35-01). The descriptor
  //    is created from the REAL measured hash — no claimed dimensions or
  //    duration are asserted. callStatus stays "succeeded" only because the
  //    command ran; mediaStatus/generationMode derive from verification
  //    alone.
  const artifactType = MODALITY_ARTIFACT_TYPE[request.modality] ?? "image";
  const mimeType = MODALITY_MIME[request.modality] ?? "image/png";
  let descriptor = null;
  let outcome = null;
  if (inspection.success === true) {
    descriptor = createArtifactDescriptor({
      artifactType,
      mimeType,
      contentSha256: inspection.contentSha256,
      producer: {
        agentId: styleProfile.agentId,
        runId: typeof opts.productionRunId === "string" ? opts.productionRunId : "visual-executor",
        stageId: "visual",
        providerId: selection.providerId,
      },
      createdAt: now().toISOString(),
    });
    const verifiedDescriptor = verifyArtifactDescriptor(descriptor, inspection);
    outcome = recordVisualGenerationOutcome({
      styleProfile,
      request,
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
      artifactType,
      mimeType,
      contentSha256: "0".repeat(64),
      producer: {
        agentId: styleProfile.agentId,
        runId: typeof opts.productionRunId === "string" ? opts.productionRunId : "visual-executor",
        stageId: "visual",
        providerId: selection.providerId,
      },
      createdAt: now().toISOString(),
    });
    outcome = recordVisualGenerationOutcome({
      styleProfile,
      request,
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
export { computeVisualOutcomeId };

// Contract tier chain passthrough for routing introspection.
export { VISUAL_PROVIDER_TIERS };
