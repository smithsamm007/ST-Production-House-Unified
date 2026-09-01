import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.content.subtitle-plan.v1";
const ALLOWED_LANGUAGES = new Set(["hindi", "hinglish"]);
const MAX_CUE_CHARS = 42;
const MAX_CUE_DURATION_SECONDS = 7.0;
const MAX_TOTAL_DURATION_SECONDS = 1800; // 30 minutes

const SHORTS_ROLES = Object.freeze([
  { role: "opening_hook", sourceBeat: "hook", targetSeconds: 30 },
  { role: "high_tension_moment", sourceBeat: "escalation", targetSeconds: 45 },
  { role: "cliffhanger_teaser", sourceBeat: "cliffhanger", targetSeconds: 30 },
]);

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator)/i;
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i"
);
const UNSUPPORTED_MARKUP = /<[^>]+>|javascript:|onerror=|onload=/i;

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function formatTimestampSRT(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatTimestampVTT(seconds) {
  return formatTimestampSRT(seconds).replace(",", ".");
}

function validatePublicText(value, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) throw new Error(errorCode);
  if (SECRET_LIKE.test(normalized)) throw new Error("SUBTITLE_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("SUBTITLE_INTERNAL_AGENT_NAME_REJECTED");
  if (UNSUPPORTED_MARKUP.test(normalized)) throw new Error("SUBTITLE_MARKUP_UNSUPPORTED");
  return normalized;
}

function validateScope(ownerId, agentId) {
  if (typeof ownerId !== "string" || !/^[a-zA-Z0-9_-]{3,80}$/.test(ownerId)) {
    throw new Error("SUBTITLE_SCOPE_INVALID_OWNER");
  }
  if (agentId !== AGENT_ID) {
    throw new Error("SUBTITLE_SCOPE_MISMATCH");
  }
}

/**
 * Splits a segment's text into bounded cues at safe word boundaries.
 */
function splitSegmentIntoCues(segment, sourceHash) {
  const { segmentId, text, startTime, endTime, speaker } = segment;
  const words = text.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) throw new Error("SUBTITLE_TEXT_EMPTY");

  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (const word of words) {
    const wordLen = word.length;
    const addedLen = currentChunk.length === 0 ? wordLen : currentLength + 1 + wordLen;

    if (addedLen > MAX_CUE_CHARS && currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
      currentChunk = [word];
      currentLength = wordLen;
    } else {
      currentChunk.push(word);
      currentLength = addedLen;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }

  // Calculate proportional durations for each chunk based on word counts
  const totalDuration = endTime - startTime;
  const totalWords = words.length;

  // Further check if chunk durations exceed MAX_CUE_DURATION_SECONDS and need sub-splitting
  const cues = [];
  let currentStartTime = startTime;

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    const chunkWords = chunkText.split(" ").length;
    const chunkDuration = i === chunks.length - 1
      ? Math.round((endTime - currentStartTime) * 1000) / 1000
      : Math.round(((totalDuration * chunkWords) / totalWords) * 1000) / 1000;

    const chunkEndTime = Math.round((currentStartTime + chunkDuration) * 1000) / 1000;

    if (chunkDuration > MAX_CUE_DURATION_SECONDS) {
      // Split chunk further in half
      const chunkWordArr = chunkText.split(" ");
      const mid = Math.ceil(chunkWordArr.length / 2);
      const sub1 = chunkWordArr.slice(0, mid).join(" ");
      const sub2 = chunkWordArr.slice(mid).join(" ");
      const midTime = Math.round((currentStartTime + chunkDuration / 2) * 1000) / 1000;

      cues.push(buildCue(segmentId, cues.length + 1, sub1, currentStartTime, midTime, speaker, sourceHash));
      cues.push(buildCue(segmentId, cues.length + 1, sub2, midTime, chunkEndTime, speaker, sourceHash));
    } else {
      cues.push(buildCue(segmentId, cues.length + 1, chunkText, currentStartTime, chunkEndTime, speaker, sourceHash));
    }

    currentStartTime = chunkEndTime;
  }

  return cues;
}

function buildCue(segmentId, index, text, start, end, speaker, sourceHash) {
  const cueIdentity = { sourceHash, segmentId, index, text, start, end, speaker };
  const cueId = `cue-${stableId(cueIdentity).substring(0, 16)}`;
  return {
    cueId,
    segmentId,
    index,
    text,
    speaker,
    startTime: start,
    endTime: end,
    durationSeconds: Math.round((end - start) * 1000) / 1000,
    startTimeSRT: formatTimestampSRT(start),
    endTimeSRT: formatTimestampSRT(end),
    startTimeVTT: formatTimestampVTT(start),
    endTimeVTT: formatTimestampVTT(end),
    srtFormatted: `${index}\n${formatTimestampSRT(start)} --> ${formatTimestampSRT(end)}\n${text}`,
    vttFormatted: `${formatTimestampVTT(start)} --> ${formatTimestampVTT(end)}\n${text}`,
  };
}

function validateNarrationSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("SUBTITLE_SEGMENTS_INVALID");
  }
  if (segments.length > 500) {
    throw new Error("SUBTITLE_SEGMENTS_EXCESSIVE");
  }

  let previousEndTime = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || typeof seg !== "object") throw new Error("SUBTITLE_SEGMENT_MALFORMED");

    if (typeof seg.segmentId !== "string" || !seg.segmentId.trim()) {
      throw new Error("SUBTITLE_SEGMENT_ID_INVALID");
    }
    const text = validatePublicText(seg.text, "SUBTITLE_TEXT_INVALID");

    const start = Number(seg.startTime);
    const end = Number(seg.endTime);

    if (!Number.isFinite(start) || start < 0) {
      throw new Error("SUBTITLE_TIMING_NEGATIVE_OR_NAN");
    }
    if (!Number.isFinite(end) || end <= start) {
      throw new Error("SUBTITLE_TIMING_NEGATIVE_OR_NAN");
    }
    if (start < previousEndTime - 0.001) {
      throw new Error("SUBTITLE_TIMING_OVERLAP_DETECTED");
    }
    if (end > MAX_TOTAL_DURATION_SECONDS) {
      throw new Error("SUBTITLE_DURATION_EXCESSIVE");
    }
    if (end - start > 120.0) {
      throw new Error("SUBTITLE_SEGMENT_DURATION_EXCESSIVE");
    }

    const speaker = seg.speaker ? validatePublicText(seg.speaker, "SUBTITLE_SPEAKER_INVALID") : "narrator";

    previousEndTime = end;
  }
}

export function createDeterministicSubtitlePlan(sourcePackage, options = {}) {
  if (!sourcePackage || typeof sourcePackage !== "object" || Array.isArray(sourcePackage)) {
    throw new Error("SUBTITLE_SOURCE_INVALID");
  }

  const ownerId = options.ownerId || sourcePackage.ownerId;
  const agentId = options.agentId || sourcePackage.agentId || AGENT_ID;
  validateScope(ownerId, agentId);

  const language = String(sourcePackage.language || "").toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) {
    throw new Error("SUBTITLE_LANGUAGE_UNSUPPORTED");
  }

  const sourceHash = sourcePackage.sourceHash || sourcePackage.packageId;
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{16,64}$/i.test(sourceHash)) {
    throw new Error("SUBTITLE_SOURCE_HASH_INVALID");
  }

  const segments = sourcePackage.narrationSegments || sourcePackage.segments;
  validateNarrationSegments(segments);

  // Split all segments into bounded long-form cues
  const longFormCues = [];
  let globalSequence = 1;

  for (const seg of segments) {
    const rawCues = splitSegmentIntoCues(seg, sourceHash);
    for (const cue of rawCues) {
      longFormCues.push({
        ...cue,
        sequence: globalSequence++,
        srtFormatted: `${globalSequence - 1}\n${cue.startTimeSRT} --> ${cue.endTimeSRT}\n${cue.text}`,
      });
    }
  }

  // Build long-form 16:9 plan profile
  const longFormPlan = {
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    totalCues: longFormCues.length,
    totalDurationSeconds: longFormCues.length > 0 ? longFormCues[longFormCues.length - 1].endTime : 0,
    cues: Object.freeze(longFormCues),
  };

  // Build exactly three Shorts (9:16) profiles: hook, tension, cliffhanger
  const totalNarrativeSeconds = longFormPlan.totalDurationSeconds;

  const shortsPlans = SHORTS_ROLES.map(({ role, sourceBeat, targetSeconds }, idx) => {
    // Select subset of cues corresponding to hook (first 20%), tension (middle), cliffhanger (end)
    let startTimeBoundary = 0;
    let endTimeBoundary = totalNarrativeSeconds;

    if (idx === 0) { // hook: first section
      startTimeBoundary = 0;
      endTimeBoundary = Math.min(targetSeconds, totalNarrativeSeconds * 0.25);
    } else if (idx === 1) { // high_tension_moment: middle section
      startTimeBoundary = totalNarrativeSeconds * 0.4;
      endTimeBoundary = Math.min(startTimeBoundary + targetSeconds, totalNarrativeSeconds * 0.75);
    } else { // cliffhanger_teaser: ending section, excluding final reveal
      startTimeBoundary = Math.max(0, totalNarrativeSeconds - targetSeconds - 5);
      endTimeBoundary = totalNarrativeSeconds - 1.0; // strictly no ending disclosure
    }

    const shortCues = longFormCues
      .filter((c) => c.startTime >= startTimeBoundary && c.endTime <= endTimeBoundary + 2.0)
      .map((c, seqIdx) => ({
        ...c,
        sequence: seqIdx + 1,
        srtFormatted: `${seqIdx + 1}\n${c.startTimeSRT} --> ${c.endTimeSRT}\n${c.text}`,
      }));

    return Object.freeze({
      shortIndex: idx + 1,
      role,
      sourceBeat,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      targetSeconds,
      endingRevealAllowed: false,
      endingDisclosure: role === "cliffhanger_teaser" ? "ending_not_revealed" : "not_applicable",
      totalCues: shortCues.length,
      cues: Object.freeze(shortCues),
    });
  });

  if (shortsPlans.length !== 3) {
    throw new Error("SUBTITLE_SHORTS_POLICY_VIOLATION");
  }

  const packageIdentity = {
    sourceHash,
    ownerId,
    agentId,
    language,
    longFormCueCount: longFormCues.length,
    shortsCount: shortsPlans.length,
  };
  const packageId = stableId(packageIdentity);

  return Object.freeze({
    schemaVersion: 1,
    packageId,
    packageType: "subtitle_plan_v1",
    sourceHash,
    sourcePackageId: sourceHash,
    readiness: "subtitle_plan_only",
    generationMode: "deterministic_local",
    ownerId,
    agentId,
    language,
    longFormPlan: Object.freeze(longFormPlan),
    shortsPlans: Object.freeze(shortsPlans),
    generatedMedia: Object.freeze([]),
    providerCalls: Object.freeze([]),
    artifacts: Object.freeze([]),
    publication: Object.freeze({ requested: false, status: "not_requested" }),
  });
}

export async function deterministicSubtitlePlanHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) {
    throw new Error("SUBTITLE_SCOPE_MISMATCH");
  }
  const sourcePackage = ctx.payload?.narrationPackage || ctx.payload?.sourcePackage;
  const ownerId = ctx.context?.ownerId || ctx.payload?.ownerId;

  const plan = createDeterministicSubtitlePlan(sourcePackage, { ownerId, agentId: ctx.agentId });

  ctx.heartbeat("subtitle_segments_validated", 30, { generationMode: "deterministic_local" });
  await ctx.checkpoint("subtitle_segments_validated", 30, { sourceHash: plan.sourceHash });
  await ctx.checkpoint("subtitle_plan_ready", 100, { packageId: plan.packageId, readiness: plan.readiness });

  return plan;
}
