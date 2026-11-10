/**
 * ST Production House — durable rehearsal evidence bundles (Issue #264).
 *
 * WHY THIS EXISTS:
 *   `artifacts/rehearsal/**` is git-ignored, so a rehearsal's evidence existed
 *   only on the machine that ran it. Issue #264 makes that evidence durable as
 *   a CI artifact — which means the raw record (absolute paths, host
 *   identifiers, and any secret-adjacent field a future runner adds) must never
 *   be uploaded as-is.
 *
 * CONTRACT:
 *   - **Allowlist, not denylist.** `sanitizeRehearsalEvidence` builds a NEW
 *     object from named fields. Unknown keys never survive, so a runner that
 *     later records something sensitive cannot leak it by being forgotten.
 *   - Required measurements are validated. A bundle missing a measured value
 *     is refused (`EVIDENCE_REQUIRED_FIELD_MISSING` / `EVIDENCE_FIELD_INVALID`);
 *     nothing is filled in with a default (AGENTS.md Rules 1–3).
 *   - `assertSanitizedBundle` re-scans the finished bundle for absolute paths,
 *     forbidden keys and secret-shaped keys, and refuses to hand back a bundle
 *     that still contains them (`EVIDENCE_SANITIZATION_INCOMPLETE`).
 *   - Pure and offline: no filesystem, clock or process access.
 */

export const REHEARSAL_EVIDENCE_BUNDLE_VERSION = "rehearsal_evidence_bundle_v1";

export const EVIDENCE_TARGET_SECONDS = Object.freeze([1800, 2400, 3000]);

export const EVIDENCE_BUNDLE_ERROR_CODES = Object.freeze([
  "EVIDENCE_INPUT_INVALID",
  "EVIDENCE_REQUIRED_FIELD_MISSING",
  "EVIDENCE_FIELD_INVALID",
  "EVIDENCE_SANITIZATION_INCOMPLETE",
]);

const ABSOLUTE_PATH_SOURCE =
  "(?:\\/(?:workspace|home|tmp|root|var|mnt|opt|Users)\\/[^\\s\"',)]*)|(?:[A-Za-z]:\\\\[^\\s\"',)]*)";
const ABSOLUTE_PATH_PATTERN = new RegExp(ABSOLUTE_PATH_SOURCE);
const SECRET_KEY_PATTERN =
  /"[^"]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL|CONNECTION_STRING)[^"]*"\s*:/i;
const FORBIDDEN_KEY_PATTERN =
  /^(?:outputPath|inputPath|filePath|absolutePath|cwd|env|environment|hostname|authorization|token|apiKey|secret|password)$/i;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function evidenceError(code, detail, extra) {
  const error = new Error(detail ?? code);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Absolute path → basename only. Anything else → null. */
export function redactPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  return segments[segments.length - 1].slice(0, 200);
}

/** Scrub absolute paths and credential-shaped fragments out of free text. */
export function scrubText(value, maxLength = 400) {
  if (typeof value !== "string") return null;
  const scrubbed = value
    .replace(new RegExp(ABSOLUTE_PATH_SOURCE, "g"), "[redacted-path]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "[redacted-token]")
    .replace(/\b(?:sk|pk)_(?:live|test)?_?[A-Za-z0-9]{12,}/g, "[redacted-token]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"',)]*/g, "[redacted-url]");
  const trimmed = scrubbed.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int(value) {
  return Number.isInteger(value) ? value : null;
}

function flag(value) {
  return value === true;
}

function codes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && CODE_PATTERN.test(entry)).slice(0, 24);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw evidenceError("EVIDENCE_REQUIRED_FIELD_MISSING", `missing object: ${field}`, { field });
  }
  return value;
}

function requireString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw evidenceError("EVIDENCE_REQUIRED_FIELD_MISSING", `missing string: ${field}`, { field });
  }
  return scrubText(value, maxLength ?? 200);
}

function requireNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw evidenceError("EVIDENCE_REQUIRED_FIELD_MISSING", `missing measured number: ${field}`, { field });
  }
  return value;
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw evidenceError("EVIDENCE_FIELD_INVALID", `not a positive integer: ${field}`, { field });
  }
  return value;
}

function requireSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw evidenceError("EVIDENCE_FIELD_INVALID", `not a sha256 hex digest: ${field}`, { field });
  }
  return value;
}

function requireIsoTimestamp(value) {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw evidenceError("EVIDENCE_FIELD_INVALID", "generatedAt is not an ISO-8601 UTC timestamp", {
      field: "generatedAt",
    });
  }
  return value;
}

function requireTargetSeconds(value) {
  if (!EVIDENCE_TARGET_SECONDS.includes(value)) {
    throw evidenceError(
      "EVIDENCE_FIELD_INVALID",
      `target.targetSeconds must be one of ${EVIDENCE_TARGET_SECONDS.join("/")}`,
      { field: "target.targetSeconds" },
    );
  }
  return value;
}

function sanitizeStreams(streams) {
  if (!Array.isArray(streams)) return [];
  return streams.slice(0, 16).map((stream) => {
    const input = isPlainObject(stream) ? stream : {};
    return {
      codecType: scrubText(input.codec_type ?? input.codecType, 40),
      codecName: scrubText(input.codec_name ?? input.codecName, 40),
      width: int(input.width),
      height: int(input.height),
      sampleRate: int(Number(input.sample_rate ?? input.sampleRate)) || null,
      channels: int(input.channels),
      channelLayout: scrubText(input.channel_layout ?? input.channelLayout, 60),
      frameRate: scrubText(input.avg_frame_rate ?? input.frameRate, 40),
      durationSeconds: num(Number(input.duration)),
    };
  });
}

function pickLoudness(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    integratedLufs: num(source.integratedLufs),
    truePeakDbtp: num(source.truePeakDbtp),
    loudnessRangeLu: num(source.loudnessRangeLu),
    thresholdLufs: num(source.thresholdLufs),
    peakLevelDbfs: num(source.peakLevelDbfs),
    peakLevelSampleCount: int(source.peakLevelSampleCount),
    clippedSampleCount: int(source.clippedSampleCount),
    clippingBasis: scrubText(source.clippingBasis, 80),
    integratedDeltaLu: num(source.integratedDeltaLu),
    passed: flag(source.passed),
    reasonCodes: codes(source.reasonCodes),
  };
}

function sanitizeNarration(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    scriptType: scrubText(source.scriptType, 80),
    generationMode: scrubText(source.generationMode, 80),
    editorialStatus: scrubText(source.editorialStatus, 80),
    language: scrubText(source.language, 20),
    wordCount: int(source.wordCount),
    plannedSeconds: num(source.plannedSeconds),
    textSha256: typeof source.textSha256 === "string" && SHA256_PATTERN.test(source.textSha256) ? source.textSha256 : null,
  };
}

function sanitizeSpeech(input) {
  const source = requireObject(input, "speechSynthesis");
  const attempts = Array.isArray(source.calibration)
    ? source.calibration.slice(0, 32).map((attempt) => {
        const entry = isPlainObject(attempt) ? attempt : {};
        return {
          attempt: int(entry.attempt),
          rate: num(entry.rate),
          measuredDurationSeconds: num(entry.measuredDurationSeconds),
        };
      })
    : [];
  return {
    provider: scrubText(source.provider, 160),
    voice: scrubText(source.voice, 60),
    settledRate: num(source.settledRate),
    settledMeasuredAudioSeconds: requireNumber(
      source.settledMeasuredAudioSeconds,
      "speechSynthesis.settledMeasuredAudioSeconds",
    ),
    attempts,
  };
}

function sanitizeAssembly(input) {
  const source = requireObject(input, "assembly");
  return {
    tool: scrubText(source.tool, 200),
    visualProvenance: scrubText(source.visualProvenance, 600),
    streams: sanitizeStreams(source.streams),
    outputSha256: requireSha256(source.outputSha256, "assembly.outputSha256"),
    outputSizeBytes: requirePositiveInt(source.outputSizeBytes, "assembly.outputSizeBytes"),
  };
}

function sanitizeLoudness(input) {
  const source = isPlainObject(input) ? input : {};
  const target = isPlainObject(source.target) ? source.target : {};
  const normalization = isPlainObject(source.normalization) ? source.normalization : {};
  const conformance = isPlainObject(source.conformance) ? source.conformance : {};
  const measured = isPlainObject(conformance.measured) ? conformance.measured : {};
  return {
    target: {
      integratedLufs: num(target.integratedLufs),
      truePeakDbtp: num(target.truePeakDbtp),
      loudnessRangeLu: num(target.loudnessRangeLu),
      integratedToleranceLu: num(target.integratedToleranceLu),
    },
    measuredInput: pickLoudness(source.measuredInput),
    normalization: {
      applied: flag(normalization.applied),
      reason: scrubText(normalization.reason, 240),
      filter: scrubText(normalization.filter, 600),
      outputName: redactPath(normalization.outputName),
    },
    measuredOutput: pickLoudness(source.measuredOutput),
    conformance: {
      passed: flag(conformance.passed),
      reasonCodes: codes(conformance.reasonCodes),
      integratedDeltaLu: num(conformance.integratedDeltaLu),
      measured: {
        integratedLufs: num(measured.integratedLufs),
        truePeakDbtp: num(measured.truePeakDbtp),
        loudnessRangeLu: num(measured.loudnessRangeLu),
        peakLevelDbfs: num(measured.peakLevelDbfs),
        clippedSampleCount: int(measured.clippedSampleCount),
      },
    },
  };
}

function sanitizeTechnical(input) {
  const source = isPlainObject(input) ? input : {};
  const measured = isPlainObject(source.measured) ? source.measured : {};
  return {
    profile: scrubText(source.profile, 80),
    delivery: flag(source.delivery),
    passed: flag(source.passed),
    reasonCodes: codes(source.reasonCodes),
    measured: {
      width: int(measured.width),
      height: int(measured.height),
      frameRate: num(measured.frameRate),
      sampleRate: int(measured.sampleRate),
      videoCodec: scrubText(measured.videoCodec, 40),
      audioCodec: scrubText(measured.audioCodec, 40),
    },
    note: scrubText(source.note, 400),
  };
}

function sanitizeGate(input) {
  const source = requireObject(input, "completenessGate");
  if (typeof source.passed !== "boolean") {
    throw evidenceError("EVIDENCE_REQUIRED_FIELD_MISSING", "missing boolean: completenessGate.passed", {
      field: "completenessGate.passed",
    });
  }
  requireNumber(source.audioSeconds, "completenessGate.audioSeconds");
  requireNumber(source.audioCoverageRatio, "completenessGate.audioCoverageRatio");
  return {
    gate: scrubText(source.gate, 240),
    passed: source.passed,
    reasonCode: scrubText(source.reasonCode, 80),
    videoSeconds: num(source.videoSeconds),
    audioSeconds: num(source.audioSeconds),
    referenceSeconds: num(source.referenceSeconds),
    coverageToleranceSeconds: num(source.coverageToleranceSeconds),
    audioCoverageRatio: num(source.audioCoverageRatio),
  };
}

/**
 * Build a durable, shareable bundle from one rehearsal evidence record.
 * Throws rather than dropping a required measurement.
 */
export function sanitizeRehearsalEvidence(evidence, { sourceName = null } = {}) {
  if (!isPlainObject(evidence)) throw evidenceError("EVIDENCE_INPUT_INVALID");

  const target = requireObject(evidence.target, "target");
  const audioWindow =
    Array.isArray(target.audioWindow) && target.audioWindow.length === 2 && target.audioWindow.every((value) => typeof value === "number" && Number.isFinite(value))
      ? [target.audioWindow[0], target.audioWindow[1]]
      : null;

  const bundle = {
    bundleVersion: REHEARSAL_EVIDENCE_BUNDLE_VERSION,
    bundleKind: "sanitized_rehearsal_evidence",
    source: { file: redactPath(sourceName) },
    rehearsalId: requireString(evidence.rehearsalId, "rehearsalId"),
    generatedAt: requireIsoTimestamp(evidence.generatedAt),
    target: {
      targetSeconds: requireTargetSeconds(target.targetSeconds),
      audioWindow,
    },
    narration: sanitizeNarration(evidence.narration),
    speechSynthesis: sanitizeSpeech(evidence.speechSynthesis),
    assembly: sanitizeAssembly(evidence.assembly),
    loudness: sanitizeLoudness(evidence.loudness),
    technical: sanitizeTechnical(evidence.technical),
    completenessGate: sanitizeGate(evidence.completenessGate),
    honestLimits: Array.isArray(evidence.honestLimits)
      ? evidence.honestLimits
          .slice(0, 16)
          .map((entry) => scrubText(entry, 400))
          .filter((entry) => entry !== null)
      : [],
  };

  return deepFreeze(assertSanitizedBundle(bundle));
}

function walk(value, pathParts, problems) {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH_PATTERN.test(value)) problems.push(`absolute_path:${pathParts.join(".")}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) problems.push(`forbidden_key:${[...pathParts, key].join(".")}`);
    walk(child, [...pathParts, key], problems);
  }
}

/**
 * Refuse a bundle that still carries an absolute path, a forbidden key or a
 * secret-shaped key. Returns the bundle unchanged when clean.
 */
export function assertSanitizedBundle(bundle) {
  const problems = [];
  walk(bundle, [], problems);
  const serialized = JSON.stringify(bundle);
  if (SECRET_KEY_PATTERN.test(serialized)) problems.push("secret_shaped_key");
  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    throw evidenceError(
      "EVIDENCE_SANITIZATION_INCOMPLETE",
      `sanitized bundle still contains: ${unique.join(", ")}`,
      { problems: unique },
    );
  }
  return bundle;
}

/** Serialize a clean bundle (2-space JSON + trailing newline). */
export function serializeRehearsalEvidenceBundle(bundle) {
  assertSanitizedBundle(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
