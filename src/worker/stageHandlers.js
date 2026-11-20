/**
 * ST Production House — formal stage-handler registry (Day 6).
 *
 * Every production stage must have an explicitly registered handler. There is no
 * silent placeholder fallback: an unregistered stage fails with
 * UNSUPPORTED_STAGE, a stage whose provider is absent fails with
 * PROVIDER_NOT_CONFIGURED, and a stage that is an Owner decision fails with
 * OWNER_APPROVAL_REQUIRED.
 *
 * What "provider-independent" means here
 * --------------------------------------
 * A handler in this file either (a) transforms real bytes supplied by the task's
 * persisted input, or (b) validates real persisted upstream evidence. Neither
 * fabricates media, calls a model, or claims a provider ran. Metadata-only output
 * is labelled `metadataOnly: true` and `mediaFiles: []` so no downstream reader
 * can mistake it for a video, image, voice track or render.
 *
 * Provider-backed stages (VISUALS, ANIMATION, VOICE, MUSIC, ASSEMBLY, PUBLISHING,
 * ANALYTICS) are declared but not implemented: they report an honest blocked
 * state. FFPROBE is implemented against the real `ffprobe` binary and is only
 * available when that binary exists in the runtime environment.
 *
 * Nothing here touches the database. The worker runtime persists what a handler
 * returns after the evidence contract accepts it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  PRODUCTION_STAGES,
  STAGE_DEPENDENCIES,
  STAGE_EVIDENCE_REQUIREMENTS,
  STAGE_HASH_REQUIRED,
  dependenciesOf,
  evidenceRequiredFor,
} from "../fleet/fleetPolicy.js";
import {
  STAGE_ERROR,
  StageError,
  VERIFICATION_LEVEL,
  assertNoSecretMaterial,
  canonicalJson,
  sha256Bytes,
} from "./evidenceContract.js";

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_INPUT_BYTES_HARD = 8 * 1024 * 1024;

function checks(all) {
  return all.map((check) => ({ name: check.name, ok: check.ok === true, detail: check.detail ?? null }));
}

function failedChecks(results) {
  return results.filter((check) => !check.ok).map((check) => check.name);
}

function assertChecks(results, { code = STAGE_ERROR.STAGE_INPUT_INVALID, label = "input" } = {}) {
  const failed = failedChecks(results);
  if (failed.length > 0) {
    throw new StageError(code, `Stage ${label} failed validation: ${failed.join(", ")}.`, {
      checks: results,
      failed,
    });
  }
  return results;
}

/** Resolve a task-supplied file reference, refusing paths outside the root. */
function readArtifact(artifactsRoot, ref, { maxBytes = MAX_INPUT_BYTES_HARD } = {}) {
  if (typeof artifactsRoot !== "string" || artifactsRoot.length === 0) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "No artifact root is configured for this worker.");
  }
  if (typeof ref !== "string" || ref.trim().length === 0 || ref.length > 400) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "A relative artifact reference is required.");
  }
  const root = path.resolve(artifactsRoot);
  const resolved = path.resolve(root, ref);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "The artifact reference escapes the worker artifact root.");
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "The referenced artifact does not exist.");
  }
  const size = statSync(resolved).size;
  if (size > maxBytes) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, `The referenced artifact exceeds ${maxBytes} bytes.`);
  }
  return { bytes: readFileSync(resolved), size, name: path.basename(resolved) };
}

/**
 * Read text from either an inline string or a real file. Inline text is only
 * accepted when it is bounded; production tasks normally carry a reference.
 */
function readTextInput(input, { inlineKey, refKey, artifactsRoot, maxBytes = MAX_INPUT_BYTES }) {
  const inline = input?.[inlineKey];
  if (typeof inline === "string" && inline.length > 0) {
    const bytes = Buffer.from(inline, "utf8");
    if (bytes.length > maxBytes) {
      throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, `Inline ${inlineKey} exceeds ${maxBytes} bytes.`);
    }
    return { bytes, text: inline, sourceRef: null };
  }
  const artifact = readArtifact(artifactsRoot, input?.[refKey], { maxBytes });
  const text = artifact.bytes.toString("utf8");
  if (text.includes("\u0000")) {
    throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "The referenced document is not UTF-8 text.");
  }
  return { bytes: artifact.bytes, text, sourceRef: input[refKey] };
}

function evidenceEntry({ stage, handler, evidenceType, artifactHash, payload, inputRefs, outputRefs, validation, startedAt, completedAt, environment, testFixture }) {
  return {
    evidenceType,
    artifactHash: artifactHash ?? null,
    payload: {
      stage,
      ...payload,
      // Metadata-only output is always explicit. Never imply a media file exists.
      mediaFiles: payload?.mediaFiles ?? [],
    },
    handlerName: handler.handlerName,
    handlerVersion: handler.handlerVersion,
    verificationLevel: handler.verificationLevel,
    environment,
    testFixture: testFixture === true,
    inputRefs: inputRefs ?? [],
    outputRefs: outputRefs ?? [{ kind: payload?.outputKind ?? "metadata", ref: `stage://${stage.toLowerCase()}` }],
    validation,
    startedAt,
    completedAt,
  };
}

// --------------------------------------------------------------------- handlers

const researchHandler = {
  stage: "RESEARCH",
  handlerName: "research-brief-structurer",
  handlerVersion: "1.0.0",
  description:
    "Structures a real, persisted source document into a research brief. Deterministic; no provider and no network access.",
  providerRequired: false,
  available: true,
  evidenceType: "research_brief",
  requiredCapabilities: Object.freeze(["document.structure"]),
  timeoutMs: 15_000,
  outputSchema: Object.freeze({
    outputKind: "research_brief",
    metadataOnly: true,
    fields: ["sourceHash", "title", "findingCount", "sentenceCount", "findings"],
  }),
  verificationLevel: VERIFICATION_LEVEL.IMPLEMENTED,
  execute({ input, handler, artifactsRoot, startedAt, completedAt, environment, testFixture, resumeFrom }) {
    const source = readTextInput(input, {
      inlineKey: "sourceText",
      refKey: "sourceRef",
      artifactsRoot,
    });
    const sourceHash = sha256Bytes(source.bytes);
    const findings = source.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^([-*]|\d+[.)])\s+\S/.test(line))
      .map((line) => line.replace(/^([-*]|\d+[.)])\s+/, "").slice(0, 300));
    const titleLine = source.text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    const sentenceCount = source.text.split(/[.!?]+\s/).filter((part) => part.trim().length > 20).length;
    const results = checks([
      { name: "minimum_bytes", ok: source.bytes.length >= 400, detail: `${source.bytes.length} bytes` },
      { name: "has_title", ok: titleLine.length >= 3 && titleLine.length <= 200, detail: titleLine.slice(0, 80) },
      { name: "minimum_findings", ok: findings.length >= 3, detail: `${findings.length} findings` },
      { name: "minimum_sentences", ok: sentenceCount >= 5, detail: `${sentenceCount} sentences` },
    ]);
    assertChecks(results, { label: "source document" });

    const checkpointKey = `research:${sourceHash.slice(0, 12)}`;
    const resumed = Boolean(resumeFrom && resumeFrom.key === checkpointKey);
    const payload = {
      outputKind: "research_brief",
      metadataOnly: true,
      sourceHash,
      sourceRef: source.sourceRef,
      sourceBytes: source.bytes.length,
      title: titleLine.slice(0, 200),
      findingCount: findings.length,
      sentenceCount,
      findings: findings.slice(0, 50),
      providerUsed: false,
      ...(resumed ? { resumedFromCheckpoint: true } : {}),
    };
    return {
      resultRef: `director-stage://research/${sourceHash.slice(0, 32)}`,
      payload,
      validation: { checks: results, checkpoint: checkpointKey },
      checkpoints: [{ key: checkpointKey, payload: { sourceHash, findingCount: findings.length } }],
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: sourceHash,
          payload: context.payload,
          inputRefs: [{ kind: "source_document", ref: source.sourceRef ?? "task.input.sourceText", hash: sourceHash }],
          validation: { checks: results, checkpoint: checkpointKey },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

const scriptHandler = {
  stage: "SCRIPT",
  handlerName: "script-structure-validator",
  handlerVersion: "1.0.0",
  description:
    "Validates the structure of a real, persisted script document and records its measured word/scene counts. No generation, no provider.",
  providerRequired: false,
  available: true,
  evidenceType: "script",
  requiredCapabilities: Object.freeze(["document.structure"]),
  timeoutMs: 15_000,
  outputSchema: Object.freeze({
    outputKind: "script_structure_report",
    metadataOnly: true,
    fields: ["scriptHash", "wordCount", "sceneCount", "estimatedDurationSeconds"],
  }),
  verificationLevel: VERIFICATION_LEVEL.IMPLEMENTED,
  execute({ input, handler, artifactsRoot, startedAt, completedAt, environment, testFixture }) {
    const script = readTextInput(input, {
      inlineKey: "scriptText",
      refKey: "scriptRef",
      artifactsRoot,
    });
    const scriptHash = sha256Bytes(script.bytes);
    const lines = script.text.split(/\r?\n/);
    const scenes = lines.filter((line) => /^\s*(SCENE\s+\d+|INT\.|EXT\.|INT\/EXT)/i.test(line));
    const words = script.text.trim().split(/\s+/).filter(Boolean);
    const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(script.text);
    const results = checks([
      { name: "valid_utf8_text", ok: !controlCharacters },
      { name: "minimum_words", ok: words.length >= 100, detail: `${words.length} words` },
      { name: "bounded_words", ok: words.length <= 25_000, detail: `${words.length} words` },
      { name: "minimum_scenes", ok: scenes.length >= 2, detail: `${scenes.length} scenes` },
    ]);
    assertChecks(results, { label: "script document" });

    // 150 spoken words per minute is a stated planning estimate, not a render.
    const estimatedDurationSeconds = Math.round((words.length / 150) * 60);
    return {
      resultRef: `director-stage://script/${scriptHash.slice(0, 32)}`,
      payload: {
        outputKind: "script_structure_report",
        metadataOnly: true,
        scriptHash,
        scriptRef: script.sourceRef,
        wordCount: words.length,
        sceneCount: scenes.length,
        estimatedDurationSeconds,
        durationEstimateBasis: "150 words per minute planning estimate",
        providerUsed: false,
        generated: false,
      },
      validation: { checks: results },
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: scriptHash,
          payload: context.payload,
          inputRefs: [{ kind: "script_document", ref: script.sourceRef ?? "task.input.scriptText", hash: scriptHash }],
          validation: { checks: results },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

const charactersHandler = {
  stage: "CHARACTERS",
  handlerName: "character-metadata-validator",
  handlerVersion: "1.0.0",
  description:
    "Validates persisted character metadata (identity, role, continuity key). It validates metadata; it does not design or generate a character.",
  providerRequired: false,
  available: true,
  evidenceType: "character_sheet",
  requiredCapabilities: Object.freeze(["metadata.validation"]),
  timeoutMs: 10_000,
  outputSchema: Object.freeze({
    outputKind: "character_metadata",
    metadataOnly: true,
    containsDesign: false,
    fields: ["characterCount", "characters"],
  }),
  verificationLevel: VERIFICATION_LEVEL.IMPLEMENTED,
  execute({ input, handler, artifactsRoot, startedAt, completedAt, environment, testFixture }) {
    let characters = input?.characters;
    let sourceRef = "task.input.characters";
    if (!Array.isArray(characters)) {
      const artifact = readArtifact(artifactsRoot, input?.characterRef);
      sourceRef = input.characterRef;
      try {
        const parsed = JSON.parse(artifact.bytes.toString("utf8"));
        characters = Array.isArray(parsed) ? parsed : parsed?.characters;
      } catch {
        throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "The character reference is not valid JSON.");
      }
    }
    if (!Array.isArray(characters) || characters.length === 0) {
      throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "At least one character record is required.");
    }

    const normalised = characters.map((character, index) => ({
      name: String(character?.name ?? "").trim(),
      role: String(character?.role ?? "").trim(),
      continuityKey: String(character?.continuityKey ?? "").trim(),
      index,
    }));
    const names = normalised.map((character) => character.name);
    const results = checks([
      { name: "character_count", ok: normalised.length >= 1 && normalised.length <= 50, detail: `${normalised.length}` },
      {
        name: "names_present",
        ok: normalised.every((character) => character.name.length >= 1 && character.name.length <= 80),
      },
      {
        name: "roles_present",
        ok: normalised.every((character) => character.role.length >= 2 && character.role.length <= 80),
      },
      {
        name: "continuity_keys",
        ok: normalised.every((character) => /^[a-z0-9][a-z0-9_-]{1,63}$/.test(character.continuityKey)),
      },
      { name: "unique_names", ok: new Set(names).size === names.length },
    ]);
    assertChecks(results, { label: "character metadata" });

    const sheet = {
      outputKind: "character_metadata",
      metadataOnly: true,
      containsDesign: false,
      characterCount: normalised.length,
      characters: normalised.map(({ index, ...rest }) => rest),
      providerUsed: false,
    };
    const sheetHash = sha256Bytes(Buffer.from(canonicalJson(sheet.characters), "utf8"));
    return {
      resultRef: `director-stage://characters/${sheetHash.slice(0, 32)}`,
      payload: { ...sheet, sheetHash, characterRef: sourceRef },
      validation: { checks: results },
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: sheetHash,
          payload: context.payload,
          inputRefs: [{ kind: "character_metadata", ref: sourceRef, hash: sheetHash }],
          validation: { checks: results },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

const ffprobeHandler = {
  stage: "FFPROBE",
  handlerName: "ffprobe-media-inspection",
  handlerVersion: "1.0.0",
  description:
    "Runs the real ffprobe binary against a real stored media file and records the measured stream facts. Hash is computed from the actual bytes.",
  providerRequired: false,
  available: true,
  requiresTool: "ffprobe",
  evidenceType: "ffprobe_report",
  requiredCapabilities: Object.freeze(["media.ffprobe"]),
  timeoutMs: 60_000,
  outputSchema: Object.freeze({
    outputKind: "ffprobe_report",
    metadataOnly: false,
    fields: ["mediaHash", "durationSeconds", "videoStreams", "audioStreams"],
  }),
  verificationLevel: VERIFICATION_LEVEL.INTEGRATION_TESTED,
  execute({ input, handler, artifactsRoot, startedAt, completedAt, environment, testFixture, ffprobePath }) {
    const media = readArtifact(artifactsRoot, input?.mediaRef, { maxBytes: 512 * 1024 * 1024 });
    const mediaHash = sha256Bytes(media.bytes);
    let parsed;
    try {
      const output = execFileSync(
        ffprobePath,
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input.mediaRef && path.join(path.resolve(artifactsRoot), input.mediaRef)],
        { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }
      );
      parsed = JSON.parse(output);
    } catch (error) {
      throw new StageError(STAGE_ERROR.STAGE_EXECUTION_FAILED, `ffprobe could not inspect the media: ${String(error?.message ?? "").slice(0, 160)}`);
    }
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const videoStreams = streams.filter((stream) => stream.codec_type === "video").length;
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio").length;
    const durationSeconds = Number(parsed?.format?.duration ?? streams.find((stream) => stream.duration)?.duration ?? 0);
    const results = checks([
      { name: "has_streams", ok: streams.length > 0, detail: `${streams.length} streams` },
      { name: "has_video_stream", ok: videoStreams > 0 },
      { name: "positive_duration", ok: Number.isFinite(durationSeconds) && durationSeconds > 0, detail: `${durationSeconds}s` },
    ]);
    assertChecks(results, { code: STAGE_ERROR.STAGE_OUTPUT_INVALID, label: "media" });
    return {
      resultRef: `director-stage://ffprobe/${mediaHash.slice(0, 32)}`,
      payload: {
        outputKind: "ffprobe_report",
        metadataOnly: false,
        mediaHash,
        mediaRef: input.mediaRef,
        durationSeconds,
        videoStreams,
        audioStreams,
        formats: parsed?.format?.format_name ?? null,
        container: parsed?.format?.format_long_name ?? null,
      },
      validation: { checks: results },
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: mediaHash,
          payload: context.payload,
          inputRefs: [{ kind: "media_file", ref: input.mediaRef, hash: mediaHash }],
          validation: { checks: results },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

const qcHandler = {
  stage: "QC",
  handlerName: "qc-rule-executor",
  handlerVersion: "1.0.0",
  description:
    "Executes technical QC rules against the measured ffprobe evidence of the real assembled media. Rules read persisted facts; they do not re-render or invent measurements.",
  providerRequired: false,
  available: true,
  evidenceType: "qc_report",
  requiredCapabilities: Object.freeze(["qc.rules"]),
  timeoutMs: 10_000,
  outputSchema: Object.freeze({
    outputKind: "qc_report",
    metadataOnly: true,
    fields: ["rules", "passed", "mediaHash"],
  }),
  verificationLevel: VERIFICATION_LEVEL.INTEGRATION_TESTED,
  execute({ input, handler, upstreamEvidence = [], startedAt, completedAt, environment, testFixture }) {
    const probe = upstreamEvidence.find((entry) => entry.stage === "FFPROBE" && entry.evidenceType === "ffprobe_report");
    if (!probe) {
      throw new StageError(STAGE_ERROR.REQUIRED_EVIDENCE_MISSING, "QC requires measured FFPROBE evidence for this project.");
    }
    const payload = probe.payload ?? {};
    const minimumDurationSeconds = Number(input?.minimumDurationSeconds ?? 1);
    const requireAudio = input?.requireAudio !== false;
    const rules = checks([
      {
        name: "media_hash_present",
        ok: /^[a-f0-9]{64}$/.test(String(probe.artifactHash ?? payload.mediaHash ?? "")),
      },
      {
        name: "minimum_duration",
        ok: Number(payload.durationSeconds ?? 0) >= minimumDurationSeconds,
        detail: `${payload.durationSeconds ?? 0}s >= ${minimumDurationSeconds}s`,
      },
      { name: "video_stream", ok: Number(payload.videoStreams ?? 0) >= 1 },
      { name: "audio_stream", ok: requireAudio ? Number(payload.audioStreams ?? 0) >= 1 : true },
    ]);
    assertChecks(rules, { code: STAGE_ERROR.STAGE_OUTPUT_INVALID, label: "QC rules" });
    const mediaHash = String(probe.artifactHash ?? payload.mediaHash);
    return {
      resultRef: `director-stage://qc/${mediaHash.slice(0, 32)}`,
      payload: {
        outputKind: "qc_report",
        metadataOnly: true,
        passed: true,
        rules,
        mediaHash,
        measuredFromTaskId: probe.taskId ?? null,
        providerUsed: false,
      },
      validation: { rules },
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: mediaHash,
          payload: context.payload,
          inputRefs: [{ kind: "ffprobe_evidence", ref: probe.taskId ?? "project", hash: mediaHash }],
          validation: { rules },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

const packageHandler = {
  stage: "PACKAGE",
  handlerName: "package-manifest-validator",
  handlerVersion: "1.0.0",
  description:
    "Validates a persisted final package manifest and hashes its canonical bytes. Metadata-only: it never claims a rendered deliverable exists.",
  providerRequired: false,
  available: true,
  evidenceType: "final_package",
  requiredCapabilities: Object.freeze(["package.manifest"]),
  timeoutMs: 10_000,
  outputSchema: Object.freeze({
    outputKind: "final_package_manifest",
    metadataOnly: true,
    fields: ["manifestHash", "stageCount", "artifacts"],
  }),
  verificationLevel: VERIFICATION_LEVEL.IMPLEMENTED,
  execute({ input, handler, artifactsRoot, startedAt, completedAt, environment, testFixture }) {
    let manifest = input?.manifest;
    let sourceRef = "task.input.manifest";
    if (!manifest || typeof manifest !== "object") {
      const artifact = readArtifact(artifactsRoot, input?.packageRef);
      sourceRef = input.packageRef;
      try {
        manifest = JSON.parse(artifact.bytes.toString("utf8"));
      } catch {
        throw new StageError(STAGE_ERROR.STAGE_INPUT_INVALID, "The package manifest is not valid JSON.");
      }
    }
    const stages = Array.isArray(manifest?.stages) ? manifest.stages : [];
    const results = checks([
      { name: "project_identity", ok: typeof manifest?.projectId === "string" && manifest.projectId.length > 0 },
      { name: "stage_evidence_entries", ok: stages.length >= 1, detail: `${stages.length} entries` },
      {
        name: "stage_hashes",
        ok: stages.every((entry) => /^[a-f0-9]{64}$/.test(String(entry?.artifactHash ?? ""))),
      },
      {
        name: "no_fabricated_media_claim",
        ok: manifest?.mediaFiles === undefined || Array.isArray(manifest.mediaFiles),
      },
    ]);
    assertChecks(results, { label: "package manifest" });
    const manifestHash = sha256Bytes(Buffer.from(canonicalJson(manifest), "utf8"));
    return {
      resultRef: `director-stage://package/${manifestHash.slice(0, 32)}`,
      payload: {
        outputKind: "final_package_manifest",
        metadataOnly: true,
        manifestHash,
        stageCount: stages.length,
        artifacts: stages.map((entry) => ({ stage: entry.stage ?? null, artifactHash: entry.artifactHash })),
        packageRef: sourceRef,
        providerUsed: false,
      },
      validation: { checks: results },
      evidence: (context) =>
        evidenceEntry({
          stage: handler.stage,
          handler,
          evidenceType: handler.evidenceType,
          artifactHash: manifestHash,
          payload: context.payload,
          inputRefs: [{ kind: "package_manifest", ref: sourceRef, hash: manifestHash }],
          validation: { checks: results },
          startedAt,
          completedAt,
          environment,
          testFixture,
        }),
    };
  },
};

function unavailableHandler(stage, { code, reason, provider = null }) {
  return {
    stage,
    handlerName: `${stage.toLowerCase().replace(/_/g, "-")}-unavailable`,
    handlerVersion: "0.0.0",
    description: reason,
    providerRequired: provider !== null,
    provider,
    available: false,
    unavailableCode: code,
    evidenceType: evidenceRequiredFor(stage)[0] ?? null,
    requiredCapabilities: Object.freeze([]),
    timeoutMs: 0,
    outputSchema: null,
    verificationLevel: VERIFICATION_LEVEL.BLOCKED,
    execute() {
      throw new StageError(code, reason);
    },
  };
}

const PROVIDER_NOT_CONFIGURED = STAGE_ERROR.PROVIDER_NOT_CONFIGURED;

const handlers = Object.freeze({
  RESEARCH: researchHandler,
  SCRIPT: scriptHandler,
  CHARACTERS: charactersHandler,
  VISUALS: unavailableHandler("VISUALS", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "VISUALS requires a configured visual-generation provider. No provider is configured in this environment.",
    provider: "visual_generation",
  }),
  ANIMATION: unavailableHandler("ANIMATION", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "ANIMATION requires a configured animation-generation provider. No provider is configured in this environment.",
    provider: "animation_generation",
  }),
  VOICE: unavailableHandler("VOICE", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "VOICE requires a configured text-to-speech provider. No provider is configured in this environment.",
    provider: "tts",
  }),
  MUSIC: unavailableHandler("MUSIC", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "MUSIC requires a licensed music-generation source. No provider is configured in this environment.",
    provider: "music_generation",
  }),
  ASSEMBLY: unavailableHandler("ASSEMBLY", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "ASSEMBLY requires the media toolchain and generated inputs. It is not available in this environment.",
    provider: "media_toolchain",
  }),
  FFPROBE: ffprobeHandler,
  QC: qcHandler,
  PACKAGE: packageHandler,
  OWNER_APPROVAL: unavailableHandler("OWNER_APPROVAL", {
    code: STAGE_ERROR.OWNER_APPROVAL_REQUIRED,
    reason: "OWNER_APPROVAL is an Owner decision and cannot be executed by a worker.",
  }),
  PUBLISHING: unavailableHandler("PUBLISHING", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "PUBLISHING requires a configured platform connection and an unexpired Owner approval. Neither is available here.",
    provider: "publishing",
  }),
  ANALYTICS: unavailableHandler("ANALYTICS", {
    code: PROVIDER_NOT_CONFIGURED,
    reason: "ANALYTICS requires a configured analytics provider. No provider is configured in this environment.",
    provider: "analytics",
  }),
});

function publicDeclaration(handler) {
  return Object.freeze({
    stage: handler.stage,
    handlerName: handler.handlerName,
    handlerVersion: handler.handlerVersion,
    description: handler.description,
    providerRequired: handler.providerRequired === true,
    provider: handler.provider ?? null,
    available: handler.available !== false,
    unavailableCode: handler.unavailableCode ?? null,
    evidenceType: handler.evidenceType,
    requiredCapabilities: handler.requiredCapabilities ?? [],
    requiredDependencies: STAGE_DEPENDENCIES[handler.stage] ?? [],
    requiredUpstreamEvidence: (STAGE_DEPENDENCIES[handler.stage] ?? []).map((stage) => ({
      stage,
      evidenceType: evidenceRequiredFor(stage)[0] ?? null,
    })),
    hashRequired: STAGE_HASH_REQUIRED.includes(handler.stage),
    timeoutMs: handler.timeoutMs ?? 0,
    verificationLevel: handler.verificationLevel,
    outputSchema: handler.outputSchema ?? null,
  });
}

function detectFfprobe(ffprobePath) {
  try {
    const result = spawnSync(ffprobePath, ["-version"], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export class StageHandlerRegistry {
  constructor({ artifactsRoot = null, ffprobePath = null, ffprobeAvailable = null, environment = "PRODUCTION" } = {}) {
    this.artifactsRoot = artifactsRoot;
    this.ffprobePath = ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
    this.environment = environment;
    this.ffprobeAvailable = ffprobeAvailable === null ? detectFfprobe(this.ffprobePath) : ffprobeAvailable === true;
    this.descriptors = new Map();
    for (const stage of PRODUCTION_STAGES) {
      const handler = handlers[stage];
      if (!handler) continue;
      const available = handler.stage === "FFPROBE" ? handler.available !== false && this.ffprobeAvailable : handler.available !== false;
      this.descriptors.set(stage, { handler, declaration: publicDeclaration({ ...handler, available }) });
      if (handler.stage === "FFPROBE") {
        this.descriptors.get(stage).declaration = publicDeclaration({ ...handler, available });
      }
    }
  }

  /** The declared contract for a stage. Unknown stages are never invented. */
  describe(stage) {
    const descriptor = this.descriptors.get(stage);
    if (!descriptor) {
      throw new StageError(STAGE_ERROR.UNSUPPORTED_STAGE, `No stage handler is registered for ${stage}.`);
    }
    return descriptor.declaration;
  }

  list() {
    return [...this.descriptors.values()].map((descriptor) => descriptor.declaration);
  }

  /** Capability validation for a worker registration. */
  static validateCapabilities({ stageTypes = [], capabilities = [] } = {}) {
    const problems = [];
    const known = new Set(PRODUCTION_STAGES);
    for (const stage of stageTypes) {
      if (!known.has(stage)) problems.push(`unknown stage type ${stage}`);
    }
    const required = new Set();
    for (const stage of stageTypes) {
      for (const capability of handlers[stage]?.requiredCapabilities ?? []) required.add(capability);
    }
    for (const capability of required) {
      if (!capabilities.includes(capability)) problems.push(`missing capability ${capability}`);
    }
    return { ok: problems.length === 0, problems };
  }

  assertRunnable(stage) {
    const descriptor = this.descriptors.get(stage);
    if (!descriptor) {
      throw new StageError(STAGE_ERROR.UNSUPPORTED_STAGE, `No stage handler is registered for ${stage}.`);
    }
    if (!descriptor.declaration.available) {
      throw new StageError(
        descriptor.declaration.unavailableCode ?? STAGE_ERROR.PROVIDER_NOT_CONFIGURED,
        descriptor.handler.description
      );
    }
    return descriptor.handler;
  }

  /**
   * Execute a handler. Returns a concrete `{ resultRef, evidence[], checkpoints[] }`
   * or throws a StageError. Nothing is persisted here.
   */
  execute({ stage, task, input = null, upstreamEvidence = [], resumeFrom = null, environment = null, testFixture = false }) {
    const handler = this.assertRunnable(stage);
    const effectiveInput = input ?? task?.input ?? {};
    assertNoSecretMaterial(effectiveInput, { label: `stage input for ${stage}` });
    const startedAt = new Date();
    const result = handler.execute({
      input: effectiveInput,
      task,
      handler,
      upstreamEvidence,
      resumeFrom,
      artifactsRoot: this.artifactsRoot,
      ffprobePath: this.ffprobePath,
      environment: environment ?? this.environment,
      testFixture,
      startedAt,
      completedAt: new Date(),
    });
    if (!result || typeof result !== "object") {
      throw new StageError(STAGE_ERROR.STAGE_OUTPUT_INVALID, `Handler ${handler.handlerName} returned no output.`);
    }
    const completedAt = new Date();
    const evidence =
      typeof result.evidence === "function"
        ? [result.evidence({ payload: result.payload })]
        : Array.isArray(result.evidence)
          ? result.evidence
          : [
              evidenceEntry({
                stage,
                handler,
                evidenceType: handler.evidenceType,
                artifactHash: result.payload?.artifactHash ?? null,
                payload: result.payload ?? {},
                inputRefs: [],
                validation: result.validation ?? {},
                startedAt,
                completedAt,
                environment: environment ?? this.environment,
                testFixture,
              }),
            ];
    return {
      stage,
      resultRef: result.resultRef,
      payload: result.payload ?? {},
      validation: result.validation ?? {},
      checkpoints: Array.isArray(result.checkpoints) ? result.checkpoints : [],
      evidence,
      handlerName: handler.handlerName,
      handlerVersion: handler.handlerVersion,
      verificationLevel: handler.verificationLevel,
      startedAt,
      completedAt,
    };
  }
}

export function createStageHandlerRegistry(options) {
  return new StageHandlerRegistry(options);
}

export { handlers as STAGE_HANDLERS };
