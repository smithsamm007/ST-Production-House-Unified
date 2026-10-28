/**
 * ST Production House — AI News deterministic subtitle plan (Stage 4).
 *
 * Two pure, offline components:
 *
 * 1. `createNarrationInputRegistry` — validates owner/agent-SUPPLIED timed
 *    narration segments into an immutable, tamper-evident registry. The
 *    registry NEVER invents narration: it only normalizes and hashes text
 *    the caller supplied. Malformed, overlapping, unbounded, secret-bearing,
 *    or internal-name-bearing input fails closed with stable reason codes.
 *
 * 2. `createDeterministicSubtitlePlan` — converts ONE verified research
 *    brief, its approved editorial plan (plan id RECOMPUTED for tamper
 *    detection), and a registered narration input into a deterministic
 *    subtitle plan (SRT/VTT cue timings, 16:9 long-form profile plus a 9:16
 *    shorts adaptation of the same cue timeline).
 *
 * Truthfulness rules:
 * - Cue text echoes supplied narration text only, split at word boundaries.
 *   No narration sentence is ever generated here.
 * - A blocked editorial plan yields a truthful blocked subtitle result —
 *   never cue timings built on unverified claims.
 * - No provider or network calls; `publication.status` stays `not_requested`.
 * - Deterministic: identical inputs produce the identical SHA-256 plan id.
 * - Rule 15: internal agent names are rejected in public text fields.
 * - Rule 17: secret-like inputs are rejected.
 */

import { createHash } from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SCHEMA_VERSION = 1;
const REGISTRY_TYPE = "ai_news_narration_registry";
const PLAN_TYPE = "ai_news_subtitle_plan";
const AGENT_ID = "agent-ai-news";
const EDITORIAL_PLAN_TYPE = "ai_news_editorial_plan";
const SOURCE_BRIEF_TYPE = "ai_news_research_brief";

const MAX_SEGMENTS = 500;
const MAX_TEXT_CHARS = 2000;
const MAX_SPEAKER_CHARS = 60;
const MAX_SEGMENT_ID_CHARS = 120;
const MAX_SEGMENT_SECONDS = 60;
const MAX_TOTAL_SECONDS = 900;
const MAX_CUE_CHARS = 42;
const MAX_CUE_DURATION_SECONDS = 7.0;
const MAX_PAYLOAD_BYTES = 262144;
const MS = 1000;

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|client[_ -]?secret)/i;
const INTERNAL_AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);
const UNSUPPORTED_MARKUP = /<[^>]+>|javascript:|onerror=|onload=/i;

const LANGUAGES = Object.freeze(new Set(["hindi", "hinglish", "english"]));

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundMs(seconds) {
  return Math.round(seconds * MS) / MS;
}

function validatePublicText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (UNSUPPORTED_MARKUP.test(normalized)) throw new Error("SUBTITLE_MARKUP_UNSUPPORTED");
  if (INTERNAL_AGENT_NAME_PATTERN.test(normalized)) throw new Error("SUBTITLE_INTERNAL_NAME_REJECTED");
  if (SECRET_LIKE.test(normalized)) throw new Error("SUBTITLE_SECRET_REJECTED");
  return normalized;
}

function formatTimestampSRT(seconds) {
  const totalMs = Math.round(seconds * MS);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatTimestampVTT(seconds) {
  return formatTimestampSRT(seconds).replace(",", ".");
}

// ---------------------------------------------------------------------------
// Narration input registry
// ---------------------------------------------------------------------------

function validateSegmentTiming(rawStart, rawEnd, previousEndTime) {
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("SUBTITLE_TIMING_INVALID");
  }
  if (start < 0 || end <= start) {
    throw new Error("SUBTITLE_TIMING_INVALID");
  }
  if (end - start > MAX_SEGMENT_SECONDS) {
    throw new Error("SUBTITLE_SEGMENT_DURATION_EXCESSIVE");
  }
  if (start < previousEndTime) {
    throw new Error("SUBTITLE_TIMING_OVERLAP_DETECTED");
  }
  return { start: roundMs(start), end: roundMs(end) };
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("SUBTITLE_SEGMENTS_INVALID");
  }
  if (segments.length > MAX_SEGMENTS) {
    throw new Error("SUBTITLE_SEGMENTS_EXCESSIVE");
  }

  const seenIds = new Set();
  const normalized = [];
  let previousEndTime = 0;
  let totalSeconds = 0;

  for (const raw of segments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("SUBTITLE_SEGMENT_MALFORMED");
    }
    if (typeof raw.segmentId !== "string" || raw.segmentId.trim().length === 0 || raw.segmentId.length > MAX_SEGMENT_ID_CHARS) {
      throw new Error("SUBTITLE_SEGMENT_ID_INVALID");
    }
    const segmentId = raw.segmentId.trim();
    if (seenIds.has(segmentId)) {
      throw new Error("SUBTITLE_SEGMENT_DUPLICATE_ID");
    }
    seenIds.add(segmentId);

    const text = validatePublicText(raw.text, "SUBTITLE_TEXT_INVALID", 1, MAX_TEXT_CHARS);
    const speaker =
      raw.speaker === undefined || raw.speaker === null
        ? "narrator"
        : validatePublicText(raw.speaker, "SUBTITLE_SPEAKER_INVALID", 1, MAX_SPEAKER_CHARS);

    const { start, end } = validateSegmentTiming(raw.startTime, raw.endTime, previousEndTime);
    previousEndTime = end;
    totalSeconds = end;

    normalized.push({ segmentId, text, speaker, startTime: start, endTime: end });
  }

  if (totalSeconds > MAX_TOTAL_SECONDS) {
    throw new Error("SUBTITLE_TOTAL_DURATION_EXCESSIVE");
  }
  return { segments: normalized, totalDurationSeconds: totalSeconds };
}

function registryIdentity(ownerId, agentId, language, segments) {
  return {
    schemaVersion: SCHEMA_VERSION,
    registryType: REGISTRY_TYPE,
    ownerId,
    agentId,
    language,
    segments: segments.map((segment) => ({
      segmentId: segment.segmentId,
      text: segment.text,
      speaker: segment.speaker,
      startTime: segment.startTime,
      endTime: segment.endTime
    }))
  };
}

/**
 * Validates owner/agent-supplied timed narration segments and returns a
 * frozen, tamper-evident registry (SHA-256 registryId over the normalized
 * contents). Pure and deterministic; no clocks, no I/O, no providers.
 */
export function createNarrationInputRegistry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("SUBTITLE_REGISTRY_INPUT_INVALID");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("SUBTITLE_REGISTRY_SCHEMA_UNSUPPORTED");
  }

  const payloadJson = JSON.stringify(input);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    throw new Error("SUBTITLE_REGISTRY_PAYLOAD_TOO_LARGE");
  }
  if (SECRET_LIKE.test(payloadJson)) {
    throw new Error("SUBTITLE_SECRET_REJECTED");
  }

  if (typeof input.ownerId !== "string" || !/^[a-zA-Z0-9_-]{3,80}$/.test(input.ownerId)) {
    throw new Error("SUBTITLE_REGISTRY_OWNER_INVALID");
  }
  if (input.agentId !== AGENT_ID) {
    throw new Error("SUBTITLE_REGISTRY_AGENT_MISMATCH");
  }
  const language = String(input.language || "").toLowerCase();
  if (!LANGUAGES.has(language)) {
    throw new Error("SUBTITLE_REGISTRY_LANGUAGE_UNSUPPORTED");
  }

  const { segments, totalDurationSeconds } = validateSegments(input.segments);

  const registryId = sha256Hex(JSON.stringify(registryIdentity(input.ownerId, AGENT_ID, language, segments)));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    registryType: REGISTRY_TYPE,
    registryId,
    ownerId: input.ownerId,
    agentId: AGENT_ID,
    language,
    segmentCount: segments.length,
    totalDurationSeconds,
    segments: Object.freeze(segments.map((segment) => Object.freeze({ ...segment })))
  });
}

// ---------------------------------------------------------------------------
// Deterministic cue derivation (echo-only, word-bounded)
// ---------------------------------------------------------------------------

function splitTextIntoCueWordGroups(words, maxWordsByDuration) {
  const groups = [];
  let current = [];
  let currentChars = 0;

  for (const word of words) {
    const addedChars = current.length === 0 ? word.length : currentChars + 1 + word.length;
    const atWordLimit = current.length >= maxWordsByDuration;
    if ((addedChars > MAX_CUE_CHARS || atWordLimit) && current.length > 0) {
      groups.push(current);
      current = [word];
      currentChars = word.length;
    } else {
      current.push(word);
      currentChars = addedChars;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildSegmentCues(segment, registryId) {
  const words = segment.text.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) throw new Error("SUBTITLE_TEXT_INVALID");

  const duration = roundMs(segment.endTime - segment.startTime);
  const perWordSeconds = duration / words.length;
  const maxWordsByDuration =
    perWordSeconds > MAX_CUE_DURATION_SECONDS ? 1 : Math.max(1, Math.floor(MAX_CUE_DURATION_SECONDS / perWordSeconds));

  const groups = splitTextIntoCueWordGroups(words, maxWordsByDuration);

  const cues = [];
  let wordIndex = 0;
  for (const group of groups) {
    const startRaw = segment.startTime + wordIndex * perWordSeconds;
    wordIndex += group.length;
    const endRaw = wordIndex === words.length ? segment.endTime : segment.startTime + wordIndex * perWordSeconds;
    const start = roundMs(startRaw);
    const end = roundMs(endRaw);
    const text = group.join(" ");

    const cueIdentity = { registryId, segmentId: segment.segmentId, index: cues.length + 1, text, start, end, speaker: segment.speaker };
    const cueId = `cue-${sha256Hex(JSON.stringify(cueIdentity)).substring(0, 16)}`;

    cues.push({
      cueId,
      segmentId: segment.segmentId,
      speaker: segment.speaker,
      text,
      startTime: start,
      endTime: end,
      durationSeconds: roundMs(end - start),
      startTimeSRT: formatTimestampSRT(start),
      endTimeSRT: formatTimestampSRT(end),
      startTimeVTT: formatTimestampVTT(start),
      endTimeVTT: formatTimestampVTT(end)
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Subtitle plan builder
// ---------------------------------------------------------------------------

function recomputedEditorialPlanId(plan) {
  // Must mirror the identity object construction in
  // deterministicEditorialPlan.js exactly (key order included).
  const identity = {
    schemaVersion: plan.schemaVersion,
    planType: plan.planType,
    briefId: plan.briefId,
    publicBrand: plan.publicBrand,
    language: plan.language,
    tone: plan.tone,
    format: plan.format,
    planSeconds: plan.targetSeconds,
    claims: plan.selectedClaims.map((claim) => claim.claimId)
  };
  return sha256Hex(JSON.stringify(identity));
}

function blockedResult({ brief, plan, registry, language, reasonCode }) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    planType: PLAN_TYPE,
    generationMode: "deterministic_local",
    readiness: "blocked",
    planId: null,
    reasonCode,
    briefId: brief.briefId,
    editorialPlanId: plan?.planId ?? null,
    registryId: registry?.registryId ?? null,
    ownerId: brief.scope?.ownerId ?? null,
    agentId: AGENT_ID,
    language,
    longFormPlan: null,
    shortsAdaptation: null,
    generatedMedia: [],
    providerCalls: [],
    artifacts: [],
    provenance: {
      providerCalls: 0,
      networkFetches: 0,
      inventedFacts: 0,
      inventedNumbers: 0,
      inventedNarrationSegments: 0,
      note: "Blocked honestly: the supplied editorial plan was not ready. No subtitle cues were produced."
    },
    publication: { requested: false, status: "not_requested" }
  });
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("SUBTITLE_PLAN_INPUT_INVALID");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("SUBTITLE_PLAN_SCHEMA_UNSUPPORTED");
  }

  const payloadJson = JSON.stringify(input);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    throw new Error("SUBTITLE_PLAN_PAYLOAD_TOO_LARGE");
  }
  if (SECRET_LIKE.test(payloadJson)) {
    throw new Error("SUBTITLE_SECRET_REJECTED");
  }

  const brief = input.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("SUBTITLE_BRIEF_INVALID");
  }
  if (brief.schemaVersion !== 1 || brief.briefType !== SOURCE_BRIEF_TYPE) {
    throw new Error("SUBTITLE_BRIEF_CONTRACT_MISMATCH");
  }
  if (brief.generationMode !== "deterministic_local" || brief.provenance?.providerCalls !== 0) {
    throw new Error("SUBTITLE_BRIEF_NOT_LOCAL");
  }
  if (brief.scope?.agentId !== AGENT_ID) {
    throw new Error("SUBTITLE_BRIEF_AGENT_MISMATCH");
  }

  const plan = input.editorialPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("SUBTITLE_EDITORIAL_PLAN_INVALID");
  }
  if (plan.planType !== EDITORIAL_PLAN_TYPE) {
    throw new Error("SUBTITLE_EDITORIAL_PLAN_CONTRACT_MISMATCH");
  }
  if (plan.generationMode !== "deterministic_local") {
    throw new Error("SUBTITLE_EDITORIAL_PLAN_NOT_LOCAL");
  }
  if (plan.briefId !== brief.briefId) {
    throw new Error("SUBTITLE_BRIEF_PLAN_MISMATCH");
  }
  if (plan.agentId !== AGENT_ID) {
    throw new Error("SUBTITLE_PLAN_AGENT_MISMATCH");
  }
  if (plan.publication?.requested !== false || plan.publication?.status !== "not_requested") {
    throw new Error("SUBTITLE_EDITORIAL_PLAN_PUBLICATION_STATE_INVALID");
  }

  // Content-safety checks pass; enforce plan integrity last so forged ids
  // cannot bypass validation.
  if (plan.readiness !== "blocked" && recomputedEditorialPlanId(plan) !== plan.planId) {
    throw new Error("SUBTITLE_EDITORIAL_PLAN_ID_MISMATCH");
  }

  const registry = input.narration;
  if (
    !registry ||
    typeof registry !== "object" ||
    Array.isArray(registry) ||
    registry.registryType !== REGISTRY_TYPE ||
    typeof registry.registryId !== "string" ||
    !/^[a-f0-9]{64}$/.test(registry.registryId)
  ) {
    throw new Error("SUBTITLE_REGISTRY_INVALID");
  }

  // Re-validate and re-hash the registry contents: a tampered segment list
  // cannot ride in under a stolen registryId.
  const { segments, totalDurationSeconds } = validateSegments(registry.segments);
  const recomputedRegistryId = sha256Hex(
    JSON.stringify(registryIdentity(registry.ownerId, registry.agentId, registry.language, segments))
  );
  if (recomputedRegistryId !== registry.registryId) {
    throw new Error("SUBTITLE_REGISTRY_ID_MISMATCH");
  }
  if (registry.agentId !== AGENT_ID) {
    throw new Error("SUBTITLE_REGISTRY_AGENT_MISMATCH");
  }
  if (registry.language !== plan.language) {
    throw new Error("SUBTITLE_REGISTRY_LANGUAGE_MISMATCH");
  }
  if (registry.ownerId !== brief.scope?.ownerId) {
    throw new Error("SUBTITLE_REGISTRY_OWNER_MISMATCH");
  }

  return {
    brief,
    plan,
    registry: { registryId: registry.registryId, ownerId: registry.ownerId, agentId: registry.agentId, language: registry.language },
    segments,
    totalDurationSeconds
  };
}

export function createDeterministicSubtitlePlan(input) {
  const validated = validateInput(input);
  const { brief, plan, registry, segments, totalDurationSeconds } = validated;

  if (plan.readiness !== "editorial_plan_only") {
    return blockedResult({
      brief,
      plan,
      registry,
      language: registry.language,
      reasonCode: plan.reasonCode || "EDITORIAL_PLAN_BLOCKED"
    });
  }

  const longFormCues = [];
  for (const segment of segments) {
    longFormCues.push(...buildSegmentCues(segment, registry.registryId));
  }
  longFormCues.forEach((cue, index) => {
    cue.sequence = index + 1;
    cue.srtFormatted = `${cue.sequence}\n${cue.startTimeSRT} --> ${cue.endTimeSRT}\n${cue.text}`;
    cue.vttFormatted = `${cue.startTimeVTT} --> ${cue.endTimeVTT}\n${cue.text}`;
  });

  const longFormPlan = Object.freeze({
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    totalCues: longFormCues.length,
    totalDurationSeconds,
    cues: Object.freeze(longFormCues.map((cue) => Object.freeze(cue)))
  });

  // Shorts adaptation: the same verified cue timeline framed for vertical
  // distribution. Format adaptation only — no new text, no new timing.
  const shortsAdaptation = Object.freeze({
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    sourceProfile: "long_form_echo",
    totalCues: longFormCues.length,
    cues: longFormPlan.cues
  });

  const planIdentity = {
    schemaVersion: SCHEMA_VERSION,
    planType: PLAN_TYPE,
    briefId: brief.briefId,
    editorialPlanId: plan.planId,
    registryId: registry.registryId,
    language: registry.language,
    cueCount: longFormCues.length,
    totalDurationSeconds
  };
  const planId = sha256Hex(JSON.stringify(planIdentity));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    planId,
    planType: PLAN_TYPE,
    generationMode: "deterministic_local",
    readiness: "subtitle_plan_only",
    briefId: brief.briefId,
    editorialPlanId: plan.planId,
    registryId: registry.registryId,
    ownerId: brief.scope?.ownerId ?? null,
    agentId: AGENT_ID,
    language: registry.language,
    longFormPlan,
    shortsAdaptation,
    narrationEcho: Object.freeze({
      segmentCount: segments.length,
      totalDurationSeconds,
      speakers: Object.freeze([...new Set(segments.map((segment) => segment.speaker))].sort())
    }),
    generatedMedia: Object.freeze([]),
    providerCalls: Object.freeze([]),
    artifacts: Object.freeze([]),
    provenance: {
      providerCalls: 0,
      networkFetches: 0,
      inventedFacts: 0,
      inventedNumbers: 0,
      inventedNarrationSegments: 0,
      note: "Subtitle cues echo supplied narration text only, timed deterministically. No narration was generated and no provider was called."
    },
    publication: { requested: false, status: "not_requested" }
  });
}
