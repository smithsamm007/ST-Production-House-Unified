/**
 * ST Production House — FFmpeg assembly executor (Issue #174, Module 33 —
 * media pipeline: from validated plan to real media processing).
 *
 * S-M33-01 (assemblyPlan.js) validates plans and defines the fail-closed
 * main-video runtime gate. S-M30-01 (artifactDescriptor.js) anchors artifact
 * identity to content hashes. This module is the EXECUTOR boundary between
 * those contracts and actual media processing:
 *
 *   validated plan (media_assembly_plan_v1)
 *     └── executeAssemblyPlan()
 *           ├── verifyAssemblyPlanIntegrity() — tamper gate (S-M33-01)
 *           ├── resolvePlanInputs()           — artifactRefs → descriptor-bound paths
 *           ├── buildFfmpegArgs()             — ARRAY ARGS ONLY (CONVENTIONS Rule 2)
 *           ├── runFfmpeg()                   — injectable spawn, no shell
 *           ├── inspectMediaFile()            — real bytes → hash + ffprobe (Issue #170)
 *           └── evaluateMainVideoRuntimeGate() /
 *               evaluateShortFormDurationGate() — QC duration policy
 *
 * Honesty contract (AGENTS.md Rules 1–3):
 *   - Every artifact input is resolved THROUGH a descriptor: the caller
 *     supplies a map of `sha256:<64-hex>` → { descriptor, path } where the
 *     descriptor's contentSha256 must equal the ref. A plan ref without a
 *     descriptor-bound path fails closed (EXEC_REF_UNBOUND) — a plan can
 *     never direct execution to a raw, un-vetted filesystem location. Paths
 *     are shape-validated before any argv is derived (no NUL, no leading
 *     dash, no `..` traversal, bounded length) and are passed as argv
 *     values, never interpolated into a shell string.
 *   - ffmpeg absent, spawn failure, timeout, non-zero exit, unreadable
 *     rendered output, missing inspection duration, out-of-range duration:
 *     each is a TRUTHFUL failure record. A success result requires a real
 *     command execution, a real matching-hash inspection of the rendered
 *     file, and a passing QC duration gate. Nothing is fabricated.
 *   - Transports are injectable (`spawnImpl`, `readFileImpl`, clock) so the
 *     test suite proves the contract offline; production supplies
 *     node:child_process spawn (array args, shell:false) and node:fs/promises.
 *   - Labeled degradations (Rule 3) are explicit in the result object —
 *     e.g. `wipe_rendered_as_fade` — never silent.
 *   - No secrets (Rule 17); internal agent names never serialize (Rule 15).
 *   - No new status states (R5): outcomes use this slice's stable error codes
 *     plus the existing VERIFIED/UNVERIFIED verification enum.
 */

import {
  ASSEMBLY_PLAN_TYPE,
  MAIN_VIDEO_MAX_SECONDS,
  MAIN_VIDEO_MIN_SECONDS,
  evaluateMainVideoRuntimeGate,
  verifyAssemblyPlanIntegrity,
} from "./assemblyPlan.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "./artifactDescriptor.js";
import { inspectMediaFile, validateArtifactPath } from "./mediaInspectionRunner.js";

export const FFMPEG_EXECUTOR_VERSION = "ffmpeg_assembly_executor_v1";

/** Stable error codes (fail-closed). */
export const FFMPEG_EXECUTOR_ERROR_CODES = Object.freeze([
  "ASSEMBLY_PLAN_INVALID",
  "ASSEMBLY_PLAN_TYPE_MISMATCH",
  "ASSEMBLY_ID_MISMATCH",
  "EXEC_REF_UNBOUND",
  "EXEC_DESCRIPTOR_MISMATCH",
  "EXEC_OUTPUT_PATH_UNSAFE",
  "FFMPEG_SPAWN_FAILED",
  "FFMPEG_TIMEOUT",
  "FFMPEG_EXIT_NONZERO",
  "FFPROBE_VERSION_SPAWN_FAILED",
  "FFPROBE_VERSION_TIMEOUT",
  "FFPROBE_VERSION_EXIT_NONZERO",
  "QC_DESCRIPTOR_NOT_VERIFIED",
  "QC_INSPECTION_DURATION_MISSING",
  "QC_DURATION_CONFLICT",
  "QC_DURATION_OUT_OF_RANGE",
]);

/**
 * Short-form (reel) runtime window — the QC duration policy for non-main
 * output targets. Main longform keeps the S-M33-01 window [1800, 3000].
 */
export const SHORT_FORM_MIN_SECONDS = 3;
export const SHORT_FORM_MAX_SECONDS = 90;

/** Transition in/out fade length actually rendered (seconds). */
export const TRANSITION_FADE_SECONDS = 0.5;

/** Aspect-ratio normalization dimensions (deterministic render geometry). */
export const ASPECT_DIMENSIONS = Object.freeze({
  "16:9": Object.freeze({ width: 1920, height: 1080 }),
  "9:16": Object.freeze({ width: 1080, height: 1920 }),
  "1:1": Object.freeze({ width: 1080, height: 1080 }),
  "4:5": Object.freeze({ width: 1080, height: 1350 }),
});

/** Per-target encoding profile (explicit codecs — never left to defaults). */
export const TARGET_ENCODING = Object.freeze({
  main: Object.freeze({ preset: "medium", crf: 20, audioBitrateK: 192 }),
  short: Object.freeze({ preset: "veryfast", crf: 21, audioBitrateK: 128 }),
});

const TARGET_KIND = Object.freeze({
  main_longform: "main",
  content_reel_1: "short",
  content_reel_2: "short",
  brand_reel: "short",
});

const VISUAL_KINDS = new Set(["video_clip", "still_image", "title_card"]);
const AUDIO_KINDS = new Set(["voice", "bgm", "sfx"]);

const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_STDERR_TAIL = 2000;
const SIDECHAIN_DUCKING_PARAMS = "threshold=0.03:ratio=8:attack=20:release=300";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(code);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function stderrTail(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  return text.length === 0 ? null : text.slice(-MAX_STDERR_TAIL);
}

// ---------------------------------------------------------------------------
// Path + input resolution (artifactRefs resolve ONLY through descriptors)
// ---------------------------------------------------------------------------

/**
 * Validate an output path BEFORE deriving any argv from it. Shape check only
 * (existence is the transport's job): mirrors mediaInspectionRunner rules.
 */
export function validateOutputPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw fail("EXEC_OUTPUT_PATH_UNSAFE");
  }
  if (path.includes("\0")) throw fail("EXEC_OUTPUT_PATH_UNSAFE");
  if (path.startsWith("-")) throw fail("EXEC_OUTPUT_PATH_UNSAFE");
  if (path.split("/").some((segment) => segment === "..")) throw fail("EXEC_OUTPUT_PATH_UNSAFE");
  return path;
}

/** Validate one `{ descriptor, path }` binding against its `sha256:` ref. */
function validateRefBinding(ref, binding) {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    throw fail("EXEC_REF_UNBOUND");
  }
  const { descriptor, path } = binding;
  requirePlainObject(descriptor, "EXEC_REF_UNBOUND");
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw fail("EXEC_DESCRIPTOR_MISMATCH");
  }
  if (
    typeof descriptor.contentSha256 !== "string" ||
    descriptor.contentSha256.toLowerCase() !== ref.slice("sha256:".length)
  ) {
    throw fail("EXEC_DESCRIPTOR_MISMATCH");
  }
  validateArtifactPath(path); // PATH_UNSAFE propagates as the honest shape error
  return { ref, descriptor, path };
}

/**
 * Resolve every plan reference (segments, audioMix, subtitleTrack) through
 * the injected descriptor map. Deduplicated by ref (one file, one binding).
 * Extra unused bindings in the map are ignored — only refs the plan actually
 * uses are resolved.
 */
export function resolvePlanInputs(plan, artifactBindings) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  if (artifactBindings === null || typeof artifactBindings !== "object" || Array.isArray(artifactBindings)) {
    throw fail("EXEC_REF_UNBOUND");
  }
  const needed = [];
  for (const segment of plan.segments) needed.push(segment.artifactRef);
  for (const track of plan.audioMix) needed.push(track.artifactRef);
  if (plan.subtitleTrack) needed.push(plan.subtitleTrack.artifactRef);

  const byRef = new Map();
  for (const ref of needed) {
    if (byRef.has(ref)) continue;
    const binding = artifactBindings[ref];
    if (binding === undefined) throw fail("EXEC_REF_UNBOUND");
    byRef.set(ref, validateRefBinding(ref, binding));
  }
  return Object.freeze([...byRef.values()].map((entry) => Object.freeze(entry)));
}

// ---------------------------------------------------------------------------
// Pure FFmpeg argument construction (CONVENTIONS Rule 2: array args ONLY)
// ---------------------------------------------------------------------------

function escapeFilterPath(path) {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function formatGain(db) {
  return `${db}dB`;
}

function segmentDurationSeconds(segment, entry) {
  if (typeof segment.durationSeconds === "number" && Number.isFinite(segment.durationSeconds) && segment.durationSeconds > 0) {
    return segment.durationSeconds;
  }
  const claimed = entry.descriptor.durationSeconds;
  if (typeof claimed === "number" && Number.isFinite(claimed) && claimed > 0) return claimed;
  return null;
}

/**
 * Build the FFmpeg argument array plus its honest build report. Pure: no I/O,
 * no clock, no environment. Deterministic for identical plan + bindings.
 *
 * Render policy (documented in docs/media/FFMPEG_ASSEMBLY_EXECUTOR.md):
 *   - Visual segments (video_clip/still_image/title_card) form the video
 *     program; audio-kind segments (voice/bgm/sfx) form the program audio.
 *   - Program audio = concatenated audio-kind segments amixed with audioMix
 *     tracks (volume per gainDb, normalize=0). Embedded audio of visual
 *     segments is intentionally not used.
 *   - Aspect normalization: scale + pad + setsar per segment.
 *   - Transitions: cut → none; fade/dissolve → real in/out fades;
 *     wipe → rendered as a fade WITH a labeled degradation (Rule 3).
 *   - Ducking: sidechaincompress against the first voice source when one
 *     exists; otherwise static gain with a labeled degradation.
 *   - Subtitles: burned via the `subtitles` filter when video exists.
 */
export function buildRenderPlan(plan, resolvedInputs, outputPath) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  validateOutputPath(outputPath);
  if (!Array.isArray(resolvedInputs) || resolvedInputs.length === 0) {
    throw fail("EXEC_REF_UNBOUND");
  }

  const targetKind = TARGET_KIND[plan.outputTarget];
  if (targetKind !== "main" && targetKind !== "short") {
    // OUTPUT_TARGETS is a closed enum; an unknown target means the plan
    // contract changed underneath us — fail closed rather than guess.
    throw fail("ASSEMBLY_PLAN_INVALID");
  }
  const dims = ASPECT_DIMENSIONS[plan.aspectRatio];
  if (!dims) throw fail("ASSEMBLY_PLAN_INVALID");
  const encoding = TARGET_ENCODING[targetKind];

  const byRef = new Map(resolvedInputs.map((entry) => [entry.ref, entry]));
  const degradations = [];

  const segmentEntries = plan.segments.map((segment) => {
    const entry = byRef.get(segment.artifactRef);
    if (!entry) throw fail("EXEC_REF_UNBOUND");
    return { segment, entry };
  });

  const filters = [];
  const args = ["-hide_banner", "-nostdin", "-y"];

  // --- Inputs (plan order; then audioMix; then subtitle) -------------------
  let inputIndex = 0;
  const visualLabels = [];
  const audioSegmentLabels = [];
  for (const { segment, entry } of segmentEntries) {
    const duration = segmentDurationSeconds(segment, entry);
    if (entry.descriptor.artifactType === "image") {
      args.push("-loop", "1");
      if (duration !== null) args.push("-t", String(duration));
    }
    args.push("-i", entry.path);
    if (VISUAL_KINDS.has(segment.kind)) {
      // Per-segment chain: aspect normalization + transition
      const chain = [`scale=${dims.width}:${dims.height}:force_original_aspect_ratio=decrease`];
      chain.push(`pad=${dims.width}:${dims.height}:(ow-iw)/2:(oh-ih)/2`);
      chain.push("setsar=1");
      if (segment.transitionIn === "fade" || segment.transitionIn === "dissolve" || segment.transitionIn === "wipe") {
        chain.push(`fade=t=in:st=0:d=${TRANSITION_FADE_SECONDS}`);
        if (duration !== null && duration > TRANSITION_FADE_SECONDS) {
          chain.push(`fade=t=out:st=${duration - TRANSITION_FADE_SECONDS}:d=${TRANSITION_FADE_SECONDS}`);
        }
        if (segment.transitionIn === "wipe") {
          degradations.push(`wipe_rendered_as_fade:segment_${inputIndex}`);
        } else if (segment.transitionIn === "dissolve" && duration === null) {
          degradations.push(`dissolve_without_duration_fade_in_only:segment_${inputIndex}`);
        }
      }
      filters.push(`[${inputIndex}:v]${chain.join(",")}[v${visualLabels.length}]`);
      visualLabels.push(`[v${visualLabels.length}]`);
    } else if (AUDIO_KINDS.has(segment.kind)) {
      audioSegmentLabels.push(`[${inputIndex}:a]`);
    } else {
      // SEGMENT_KINDS is a closed enum; anything else is a contract break.
      throw fail("ASSEMBLY_PLAN_INVALID");
    }
    inputIndex += 1;
  }

  const audioTrackEntries = plan.audioMix.map((track) => {
    const entry = byRef.get(track.artifactRef);
    if (!entry) throw fail("EXEC_REF_UNBOUND");
    const index = inputIndex;
    inputIndex += 1;
    args.push("-i", entry.path);
    return { track, entry, index };
  });

  let subtitleInputIndex = null;
  if (plan.subtitleTrack) {
    const entry = byRef.get(plan.subtitleTrack.artifactRef);
    if (!entry) throw fail("EXEC_REF_UNBOUND");
    subtitleInputIndex = inputIndex;
    args.push("-i", entry.path);
  }

  // --- Video program -------------------------------------------------------
  let videoOutLabel = null;
  if (visualLabels.length > 0) {
    if (visualLabels.length === 1) {
      filters.push(`${visualLabels[0]}null[vcat]`);
    } else {
      filters.push(`${visualLabels.join("")}concat=n=${visualLabels.length}:v=1:a=0[vcat]`);
    }
    videoOutLabel = "[vcat]";
    if (plan.subtitleTrack) {
      const subtitleEntry = resolvedInputs.find((e) => e.ref === plan.subtitleTrack.artifactRef);
      filters.push(`${videoOutLabel}subtitles='${escapeFilterPath(subtitleEntry.path)}'[vsub]`);
      videoOutLabel = "[vsub]";
    }
  } else if (plan.subtitleTrack) {
    degradations.push("subtitle_without_video_dropped");
  }

  // --- Audio program -------------------------------------------------------
  let segAudioLabel = null;
  if (audioSegmentLabels.length === 1) {
    segAudioLabel = audioSegmentLabels[0];
  } else if (audioSegmentLabels.length > 1) {
    filters.push(`${audioSegmentLabels.join("")}concat=n=${audioSegmentLabels.length}:v=0:a=1[sega]`);
    segAudioLabel = "[sega]";
  }

  const mixLabels = [];
  if (segAudioLabel) mixLabels.push(segAudioLabel);

  let firstVoiceLabel = null;
  for (const { track, index } of audioTrackEntries) {
    if (track.role === "voice" && firstVoiceLabel === null) firstVoiceLabel = `[t${index}]`;
  }

  // Volume filters FIRST (label definition order matters in a filtergraph),
  // then ducking chains which may reference any volume label.
  for (const { track, index } of audioTrackEntries) {
    filters.push(`[${index}:a]volume=${formatGain(track.gainDb)}[t${index}]`);
  }
  for (const { track, index } of audioTrackEntries) {
    let label = `[t${index}]`;
    if (track.ducking === true) {
      if (firstVoiceLabel !== null && track.role !== "voice") {
        filters.push(`${label}${firstVoiceLabel}sidechaincompress=${SIDECHAIN_DUCKING_PARAMS}[d${index}]`);
        label = `[d${index}]`;
      } else {
        degradations.push(`ducking_without_voice_source_static_gain:track_${index}`);
      }
    }
    mixLabels.push(label);
  }

  let audioOutLabel = null;
  if (mixLabels.length === 1) {
    audioOutLabel = mixLabels[0];
  } else if (mixLabels.length > 1) {
    filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0[aout]`);
    audioOutLabel = "[aout]";
  }

  const filtergraph = filters.join(";");

  // --- Maps + codecs (explicit, never defaults) ----------------------------
  if (videoOutLabel) {
    args.push("-filter_complex", filtergraph, "-map", videoOutLabel);
    args.push("-c:v", "libx264", "-preset", encoding.preset, "-crf", String(encoding.crf), "-pix_fmt", "yuv420p");
  } else {
    args.push("-vn");
    if (filtergraph.length > 0) args.push("-filter_complex", filtergraph);
  }
  if (audioOutLabel) {
    args.push("-map", audioOutLabel, "-c:a", "aac", "-b:a", `${encoding.audioBitrateK}k`);
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", outputPath);

  return deepFreeze({ args, filtergraph: filtergraph.length > 0 ? filtergraph : null, degradations });
}

/** Argument-array-only view of the render plan (CONVENTIONS Rule 2). */
export function buildFfmpegArgs(plan, resolvedInputs, outputPath) {
  return buildRenderPlan(plan, resolvedInputs, outputPath).args;
}

// ---------------------------------------------------------------------------
// Execution (injectable spawn; array args; honest failure codes)
// ---------------------------------------------------------------------------

/**
 * Run one ffmpeg invocation.
 *
 *   spawnImpl: ({ command, args, timeoutMs }) => Promise<{
 *     exitCode: number, stdout: string, stderr: string, timedOut?: boolean
 *   }> — `command` is "ffmpeg" or "ffprobe"; production wraps
 *   node:child_process spawn with array args and NO shell.
 */
export async function runFfmpeg(args, { spawnImpl, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS } = {}) {
  if (!Array.isArray(args) || args.length === 0) throw fail("FFMPEG_SPAWN_FAILED");
  if (typeof spawnImpl !== "function") throw fail("FFMPEG_SPAWN_FAILED");
  let result;
  try {
    result = await spawnImpl({ command: "ffmpeg", args, timeoutMs });
  } catch {
    throw fail("FFMPEG_SPAWN_FAILED");
  }
  if (!result || typeof result !== "object") throw fail("FFMPEG_SPAWN_FAILED");
  if (result.timedOut === true) throw fail("FFMPEG_TIMEOUT");
  if (typeof result.exitCode !== "number") throw fail("FFMPEG_SPAWN_FAILED");
  if (result.exitCode !== 0) {
    const error = fail("FFMPEG_EXIT_NONZERO");
    error.exitCode = result.exitCode;
    error.stderrTail = stderrTail(result.stderr);
    throw error;
  }
  return Object.freeze({ exitCode: 0, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" });
}

/**
 * Honest pre-flight: can this environment execute media tooling at all?
 * Uses `ffprobe -version` (ffprobe ships with ffmpeg). Binary absent →
 * FFPROBE_VERSION_SPAWN_FAILED — the truthful state of this sandbox.
 */
export async function verifyFfmpegAvailable({ spawnImpl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof spawnImpl !== "function") throw fail("FFPROBE_VERSION_SPAWN_FAILED");
  let result;
  try {
    result = await spawnImpl({ command: "ffprobe", args: ["-version"], timeoutMs });
  } catch {
    throw fail("FFPROBE_VERSION_SPAWN_FAILED");
  }
  if (!result || typeof result !== "object") throw fail("FFPROBE_VERSION_SPAWN_FAILED");
  if (result.timedOut === true) throw fail("FFPROBE_VERSION_TIMEOUT");
  if (typeof result.exitCode !== "number") throw fail("FFPROBE_VERSION_SPAWN_FAILED");
  if (result.exitCode !== 0) throw fail("FFPROBE_VERSION_EXIT_NONZERO");
  return true;
}

// ---------------------------------------------------------------------------
// QC duration policy
// ---------------------------------------------------------------------------

/**
 * Short-form duration gate: same fail-closed structure as the S-M33-01
 * main-video gate, with the reel window [3, 90] seconds:
 *   1. descriptor must be VERIFIED (real matching inspection) else
 *      QC_DESCRIPTOR_NOT_VERIFIED (inspection reason surfaced verbatim);
 *   2. measured duration must exist (inspection.format.duration);
 *   3. claimed-vs-measured conflict > 1 s → QC_DURATION_CONFLICT;
 *   4. measured outside [3, 90] → QC_DURATION_OUT_OF_RANGE.
 * Never mutates inputs; never fabricates a pass.
 */
export function evaluateShortFormDurationGate(descriptor, inspection) {
  const promoted = verifyArtifactDescriptor(descriptor, inspection);
  if (promoted.verification.state !== "VERIFIED") {
    return {
      passed: false,
      reasonCode: "QC_DESCRIPTOR_NOT_VERIFIED",
      inspectionReasonCode: promoted.verification.reasonCode,
      measuredDurationSeconds: null,
    };
  }
  const rawDuration = inspection.format ? inspection.format.duration : undefined;
  const measured =
    typeof rawDuration === "number"
      ? rawDuration
      : typeof rawDuration === "string" && rawDuration.trim() !== "" && Number.isFinite(Number(rawDuration))
        ? Number(rawDuration)
        : null;
  if (measured === null || measured <= 0) {
    return { passed: false, reasonCode: "QC_INSPECTION_DURATION_MISSING", inspectionReasonCode: null, measuredDurationSeconds: null };
  }
  if (
    descriptor.durationSeconds !== null &&
    descriptor.durationSeconds !== undefined &&
    Math.abs(descriptor.durationSeconds - measured) > 1
  ) {
    return { passed: false, reasonCode: "QC_DURATION_CONFLICT", inspectionReasonCode: null, measuredDurationSeconds: measured };
  }
  if (measured < SHORT_FORM_MIN_SECONDS || measured > SHORT_FORM_MAX_SECONDS) {
    return { passed: false, reasonCode: "QC_DURATION_OUT_OF_RANGE", inspectionReasonCode: null, measuredDurationSeconds: measured };
  }
  return { passed: true, reasonCode: null, inspectionReasonCode: null, measuredDurationSeconds: measured };
}

// ---------------------------------------------------------------------------
// Orchestration: the honest end-to-end result
// ---------------------------------------------------------------------------

/**
 * Execute one validated assembly plan end to end.
 *
 * Options:
 *   artifactBindings — REQUIRED map: `sha256:<64-hex>` → { descriptor, path }
 *   outputPath       — REQUIRED destination of the render
 *   spawnImpl        — REQUIRED for real execution ({ command, args, timeoutMs })
 *   readFileImpl     — REQUIRED for post-render inspection (real bytes)
 *   timeoutMs / probeTimeoutMs / now — injectable bounds + clock
 *   skipPreflight    — internal/testing escape hatch; default pre-flights
 *
 * Returns a frozen, honest record. success === true ONLY when the command
 * ran, the rendered file was really hashed + probed (matching its own bytes),
 * and the QC duration policy passed. Every failure carries a stable code.
 */
export async function executeAssemblyPlan(plan, options = {}) {
  const base = {
    executorVersion: FFMPEG_EXECUTOR_VERSION,
    success: false,
    planId: null,
    productionRunId: null,
    outputTarget: null,
    aspectRatio: null,
    outputPath: null,
    command: null,
    filtergraph: null,
    executed: false,
    exitCode: null,
    stderrTail: null,
    preflight: Object.freeze({ attempted: false, failureCode: null }),
    degradations: Object.freeze([]),
    inspection: null,
    qc: null,
    descriptor: null,
    failureCode: null,
  };

  // 1. Plan integrity gates (S-M33-01) — tampered/stale plans never execute.
  try {
    requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
    if (plan.planType !== ASSEMBLY_PLAN_TYPE) {
      throw fail("ASSEMBLY_PLAN_TYPE_MISMATCH");
    }
    const integrity = verifyAssemblyPlanIntegrity(plan);
    if (!integrity.intact) throw fail(integrity.reason);
  } catch (err) {
    return deepFreeze({ ...base, failureCode: err.code ?? "ASSEMBLY_PLAN_INVALID" });
  }

  const withPlan = deepFreeze({
    ...base,
    planId: plan.id,
    productionRunId: plan.productionRunId,
    outputTarget: plan.outputTarget,
    aspectRatio: plan.aspectRatio,
  });

  // 2. Options + output path.
  let opts;
  try {
    opts = requirePlainObject(options, "EXEC_REF_UNBOUND");
    if (opts.artifactBindings === undefined || opts.outputPath === undefined) throw fail("EXEC_REF_UNBOUND");
    validateOutputPath(opts.outputPath);
  } catch (err) {
    return deepFreeze({ ...withPlan, failureCode: err.code });
  }
  const outputPath = opts.outputPath;
  const withOutput = deepFreeze({ ...withPlan, outputPath });

  // 3. Resolve inputs through descriptor bindings + build argv.
  let renderPlan;
  try {
    const resolved = resolvePlanInputs(plan, opts.artifactBindings);
    renderPlan = buildRenderPlan(plan, resolved, outputPath);
  } catch (err) {
    return deepFreeze({ ...withOutput, failureCode: err.code });
  }
  const withCommand = deepFreeze({
    ...withOutput,
    command: renderPlan.args,
    filtergraph: renderPlan.filtergraph,
    degradations: renderPlan.degradations,
  });

  const now = typeof opts.now === "function" ? opts.now : () => new Date();

  // 4. Honest pre-flight (environment truth: is media tooling even present?).
  if (opts.skipPreflight !== true) {
    try {
      await verifyFfmpegAvailable({ spawnImpl: opts.spawnImpl, timeoutMs: opts.probeTimeoutMs });
    } catch (err) {
      return deepFreeze({
        ...withCommand,
        preflight: Object.freeze({ attempted: true, failureCode: err.code }),
        failureCode: err.code,
      });
    }
  }

  // 5. Execute the real command.
  let execution;
  try {
    execution = await runFfmpeg(renderPlan.args, { spawnImpl: opts.spawnImpl, timeoutMs: opts.timeoutMs });
  } catch (err) {
    return deepFreeze({
      ...withCommand,
      executed: true,
      exitCode: typeof err.exitCode === "number" ? err.exitCode : null,
      stderrTail: err.stderrTail ?? null,
      failureCode: err.code ?? "FFMPEG_SPAWN_FAILED",
    });
  }

  // 6. Post-render inspection: REAL bytes → hash + ffprobe (Issue #170).
  const probeSpawn = opts.probeSpawnImpl ?? opts.spawnImpl;
  const inspection = await inspectMediaFile(outputPath, {
    readFileImpl: opts.readFileImpl,
    spawnImpl: probeSpawn
      ? (probeOpts) => probeSpawn({ ...probeOpts, command: "ffprobe" })
      : undefined,
    timeoutMs: opts.probeTimeoutMs,
    now,
  });

  // 7. QC duration policy on the REAL post-render inspection.
  const targetKind = TARGET_KIND[plan.outputTarget];
  let qc;
  let verifiedDescriptor = null;
  if (!inspection.success) {
    qc = deepFreeze({
      policy: targetKind === "main" ? "main_video_runtime" : "short_form_runtime",
      passed: false,
      reasonCode: "QC_DESCRIPTOR_NOT_VERIFIED",
      inspectionReasonCode: inspection.reasonCode,
      measuredDurationSeconds: null,
    });
  } else {
    // The rendered artifact's descriptor is created from the REAL measured
    // hash — no claimed duration is asserted on it (no fabricated evidence).
    const renderedDescriptor = createArtifactDescriptor({
      artifactType: "video",
      mimeType: "video/mp4",
      contentSha256: inspection.contentSha256,
      producer: {
        agentId: plan.agentId,
        runId: plan.productionRunId,
        stageId: "assembly",
        providerId: FFMPEG_EXECUTOR_VERSION,
      },
      createdAt: now().toISOString(),
    });
    const gate =
      targetKind === "main"
        ? evaluateMainVideoRuntimeGate(renderedDescriptor, inspection)
        : evaluateShortFormDurationGate(renderedDescriptor, inspection);
    qc = deepFreeze({
      policy: targetKind === "main" ? "main_video_runtime" : "short_form_runtime",
      passed: gate.passed,
      reasonCode: gate.reasonCode,
      inspectionReasonCode: gate.inspectionReasonCode,
      measuredDurationSeconds: gate.measuredDurationSeconds,
    });
    if (gate.passed) verifiedDescriptor = verifyArtifactDescriptor(renderedDescriptor, inspection);
  }

  const success = inspection.success === true && qc.passed === true;
  return deepFreeze({
    ...withCommand,
    executed: true,
    exitCode: execution.exitCode,
    stderrTail: execution.stderr.length > 0 ? execution.stderr.slice(-MAX_STDERR_TAIL) : null,
    preflight: Object.freeze({ attempted: opts.skipPreflight !== true, failureCode: null }),
    inspection,
    qc,
    descriptor: verifiedDescriptor,
    success,
    failureCode: success ? null : qc.reasonCode,
  });
}
