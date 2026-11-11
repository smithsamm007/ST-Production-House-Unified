/**
 * ST Production House — JARVIS narration script bridge (Issue #262).
 *
 * WHY THIS EXISTS:
 *   `src/pipeline/narrationScript.js` (merged in #250/#257) builds the COMPLETE
 *   duration-aligned narration script for the production pipeline, and the
 *   assembly/completeness gate measures coverage against that program length.
 *   The JARVIS orchestrator instead demanded owner-supplied
 *   `timedNarrationSegments` for its subtitle stage, so a JARVIS package could
 *   never reach a complete, gate-compatible state on its own.
 *
 *   This module is the single bridge: it builds the SAME script from a JARVIS
 *   outline and derives subtitle segments from that script's text.
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3):
 *   - The script is deterministic planning text (`deterministic_local`). It is
 *     not an editorial script and not a measurement.
 *   - Derived segment timings are the script's PLANNED beat seconds, recorded
 *     with `timingSource: "narration_script_planned_seconds"`. They are never
 *     presented as measured audio timings; the measured authority remains the
 *     real post-render FFprobe inspection consumed by the completeness gate.
 *   - No text is invented here: every derived segment is a contiguous slice of
 *     the script's own words, split only at word boundaries.
 *   - Only Hindi planning text exists in this repository. A Hinglish package
 *     therefore keeps requiring owner-supplied timed narration instead of
 *     receiving Hindi cues mislabelled as Hinglish.
 */

import { buildNarrationScript } from "../pipeline/narrationScript.js";
import { isJarvisTargetMinutes, jarvisTargetSeconds } from "./targetDuration.js";

export const JARVIS_NARRATION_SCRIPT_LANGUAGES = Object.freeze(["hindi"]);

/**
 * Derived segments must also satisfy the subtitle contract's per-segment bound
 * (120 s). A beat at 50 minutes is ~810 s, so it is split into contiguous
 * word-range chunks whose durations never exceed this bound.
 */
export const MAX_DERIVED_SEGMENT_SECONDS = 120;

/** Provenance label for derived timings: planned, never measured. */
export const DERIVED_SEGMENT_TIMING_SOURCE = "narration_script_planned_seconds";

export const JARVIS_NARRATION_SCRIPT_ERROR_CODES = Object.freeze([
  "JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID",
  "JARVIS_NARRATION_SCRIPT_LANGUAGE_UNSUPPORTED",
]);

function scriptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** True when a deterministic narration script exists for this outline language. */
export function supportsJarvisNarrationScriptLanguage(language) {
  return JARVIS_NARRATION_SCRIPT_LANGUAGES.includes(String(language || "").toLowerCase());
}

/**
 * Build the complete narration script for one JARVIS outline, sized to the
 * outline's 30 / 40 / 50-minute target.
 *
 * The title is the outline's validated `publicBrand`: the outline contract
 * carries no separate title, and inventing one would put unapproved public text
 * into the script. Returns the frozen script from `buildNarrationScript`.
 */
export function buildJarvisNarrationScript(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline)) {
    throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
  }
  if (outline.packageType !== "jarvis_mvp_story_outline" || outline.readiness !== "outline_only") {
    throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
  }
  if (!isJarvisTargetMinutes(outline.targetMinutes)) {
    throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
  }
  if (!supportsJarvisNarrationScriptLanguage(outline.language)) {
    throw scriptError("JARVIS_NARRATION_SCRIPT_LANGUAGE_UNSUPPORTED");
  }
  return buildNarrationScript({
    title: outline.publicBrand,
    targetDurationSeconds: jarvisTargetSeconds(outline.targetMinutes),
  });
}

/**
 * Derive subtitle segments from a narration script.
 *
 * Each script beat is split into `ceil(plannedSeconds / MAX_DERIVED_SEGMENT_SECONDS)`
 * contiguous chunks, distributing the beat's own words proportionally and its
 * planned milliseconds exactly (integer millisecond arithmetic; the beat's last
 * chunk always ends at the beat's cumulative planned end). The concatenation of
 * all derived segment texts equals the script body in order — no words added,
 * dropped, or reordered.
 *
 * Returns a frozen array of frozen segments:
 *   { segmentId, beat, text, startTime, endTime, speaker, timingSource }
 */
export function deriveTimedNarrationSegments(script) {
  if (!script || typeof script !== "object" || script.scriptType !== "st.narration.script.v1") {
    throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
  }
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
  }

  const derived = [];
  let cursorMs = 0;
  let segmentNumber = 0;

  for (const source of script.segments) {
    const words = String(source?.text ?? "").trim().split(/\s+/).filter(Boolean);
    const plannedSeconds = Number(source?.plannedSeconds);
    if (words.length === 0 || !Number.isFinite(plannedSeconds) || plannedSeconds <= 0) {
      throw scriptError("JARVIS_NARRATION_SCRIPT_OUTLINE_INVALID");
    }

    const chunkCount = Math.max(1, Math.ceil(plannedSeconds / MAX_DERIVED_SEGMENT_SECONDS));
    const totalMs = Math.round(plannedSeconds * 1000);
    const baseWords = Math.floor(words.length / chunkCount);
    const remainder = words.length % chunkCount;

    let wordIndex = 0;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const take = baseWords + (chunk < remainder ? 1 : 0);
      const text = words.slice(wordIndex, wordIndex + take).join(" ");
      wordIndex += take;

      // Integer millisecond boundaries: chunk N ends at floor(totalMs × (N+1) / chunkCount),
      // so the last chunk closes exactly on the beat's planned end.
      const startOffsetMs = Math.floor((totalMs * chunk) / chunkCount);
      const endOffsetMs = Math.floor((totalMs * (chunk + 1)) / chunkCount);

      segmentNumber += 1;
      derived.push(Object.freeze({
        segmentId: `script-seg-${segmentNumber}`,
        beat: source.beat,
        text,
        startTime: (cursorMs + startOffsetMs) / 1000,
        endTime: (cursorMs + endOffsetMs) / 1000,
        speaker: "narrator",
        timingSource: DERIVED_SEGMENT_TIMING_SOURCE,
      }));
    }

    cursorMs += totalMs;
  }

  return Object.freeze(derived);
}
