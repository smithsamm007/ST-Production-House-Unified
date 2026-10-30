/**
 * ST Production House — duration-aligned narration script (Issue #247 follow-up:
 * narration ⇄ episode-duration alignment).
 *
 * WHY THIS EXISTS (measured, offline):
 *   The audio stage used to hand the TTS executor a single title-derived
 *   line (`यह कहानी अब शुरू होती है: <title>.` ≈ 3 s), while the assembly
 *   QC + completeness gate (S-M41-01) demand measured audio coverage of the
 *   Director's configured 1800 / 2400 / 3000 s target within a small
 *   tolerance. Plan and gate could therefore never agree: every real run was
 *   guaranteed to fail `QC_AUDIO_COVERAGE_INSUFFICIENT`.
 *
 *   This module builds the COMPLETE narration script for one release, sized
 *   to the configured target, and the pipeline passes it to the audio stage
 *   as `stageInputs.narrationScript.text`.
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3):
 *   - Pure, deterministic, offline: no clock, no filesystem, no provider.
 *     Identical inputs produce byte-identical scripts (idempotent resume).
 *   - `generationMode` is `deterministic_local`: this is deterministic
 *     PLANNING narration, never a claim of editorial or provider output. An
 *     approved editorial script can replace it without touching this module.
 *   - Durations here are PLANNED (word count ÷ a documented planning rate).
 *     The only authority on a rendered duration is the real post-render
 *     FFprobe inspection consumed by `evaluateEpisodeCompleteness`.
 *   - Script text obeys the TTS narration rules (R15/R17): no internal agent
 *     names, no secret-shaped content, bounded length.
 */

import { EPISODE_DURATION_OPTIONS_SECONDS, DEFAULT_EPISODE_DURATION_SECONDS } from "../scheduling/directorSchedule.js";
import { audioCoverageToleranceSeconds } from "../media/episodeCompleteness.js";

export const NARRATION_SCRIPT_TYPE = "st.narration.script.v1";
export const NARRATION_SCRIPT_VERSION = "narration_script_v1";

/**
 * Documented PLANNING rate: 2.2 words/second ≈ 132 words per minute, the
 * conventional slow Hindi/English narration pace. It sizes the script; it is
 * never presented as a measurement. The real rate of any rendered audio is
 * whatever FFprobe measures, and the completeness gate — not this constant —
 * decides whether a render passes.
 */
export const NARRATION_PLANNING_WORDS_PER_SECOND = 2.2;

/** Aim this many seconds BELOW the target so the plan sits inside the QC window
 *  [target − tolerance, video + 1] instead of brushing its upper edge. */
export const NARRATION_AIM_MARGIN_SECONDS = 5;

export const NARRATION_BEATS = Object.freeze([
  "hook",
  "discovery",
  "escalation",
  "reversal",
  "cliffhanger",
]);

/** Mirrors the segment distribution of src/jarvis/deterministicNarrationPlan. */
const BEAT_WEIGHTS = Object.freeze([0.12, 0.2, 0.27, 0.23]);

/** Stable fail-closed codes. */
export const NARRATION_SCRIPT_ERROR_CODES = Object.freeze([
  "NARRATION_TARGET_UNSUPPORTED",
  "NARRATION_TITLE_INVALID",
]);

// ---------------------------------------------------------------------------
// Deterministic planning vocabulary (Hindi, matching the default `hi` voice).
// Every chunk is a grammatical phrase; sentences are composed from four slots
// so thousands of words can be produced without repeating one fixed line and
// without ever emitting an internal agent name (R15) or secret (R17).
// ---------------------------------------------------------------------------

const SUBJECTS = Object.freeze([
  "यह कहानी इस शहर की सबसे पुरानी गली की है",
  "वह अकेला मकान बरसों से किसी के इंतज़ार में खड़ा है",
  "पुरानी डायरी के हर पन्ने पर एक नया संकेत लिखा है",
  "रात की खामोशी अचानक टूट जाया करती है",
  "सुनसान रास्ते पर सिर्फ़ लालटेन की रोशनी बची है",
  "धुँधली खिड़की के पीछे हर रात कोई खड़ा रहता है",
  "बंद किवाड़ों के पीछे का अँधेरा कुछ छुपा कर रखता है",
  "थमी हुई घड़ी अब भी उसी पल पर रुकी है",
]);

const PLACES = Object.freeze([
  "पुराने किले की सीढ़ियों पर",
  "मंदिर के पीछे वाले कमरे में",
  "शहर के बाहरी इलाक़े में",
  "नदी के उस पार बने पुल पर",
  "ख़ाली स्कूल की टूटी हुई कक्षा में",
  "बंद दुकान के पुराने ताले के पीछे",
  "पहाड़ी रास्ते के आख़िरी मोड़ पर",
  "पुराने अस्पताल के लंबे गलियारे में",
]);

const TIMES = Object.freeze([
  "उस रात",
  "अगली सुबह",
  "ठीक बारह बजे",
  "शाम ढले",
  "बारिश शुरू होने से पहले",
  "चाँदनी रात में",
  "तूफ़ान के दौरान",
  "उस अजीब घंटी के बाद",
]);

const ACTIONS = Object.freeze([
  "ने एक नया रहस्य खोल दिया",
  "फिर से वही पुराना सवाल दोहराती है",
  "धीरे-धीरे अपना राज खोलती चलती है",
  "हर रात एक नया संकेत छोड़ जाती है",
  "किसी के लौटने का इंतज़ार करती रहती है",
  "चुपचाप सब कुछ देखती रहती है",
  "कहानी को आगे बढ़ाती जाती है",
  "दर्शक को एक नई दिशा दिखाती है",
  "पुरानी गलती की ओर लौट आती है",
  "बिना जवाब के एक और इंतज़ार छोड़ जाती है",
]);

const MIN_FINAL_SEGMENT_WORDS = 6;

function scriptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeTitle(value) {
  if (typeof value !== "string") throw scriptError("NARRATION_TITLE_INVALID");
  const title = value.trim().replace(/\s+/g, " ");
  if (title.length === 0 || title.length > 300) throw scriptError("NARRATION_TITLE_INVALID");
  return title;
}

/** One grammatical planning sentence; deterministic in `index`. */
function planningSentence(index) {
  const subject = SUBJECTS[index % SUBJECTS.length];
  const place = PLACES[(index * 3 + 1) % PLACES.length];
  const time = TIMES[(index * 5 + 2) % TIMES.length];
  const action = ACTIONS[(index * 7 + 3) % ACTIONS.length];
  return `${subject} ${place} ${time} ${action}`.replace(/\s+/g, " ");
}

/**
 * Compose EXACTLY `wordCount` words of planning narration, returned as an
 * array of sentences. The tail is trimmed/extended to hit the budget exactly
 * (never shorter, so the planned duration can only be reached, not faked).
 */
function composeSegmentWords(wordCount) {
  const sentences = [];
  let produced = 0;
  let index = Math.max(0, wordCount % 97);
  while (produced < wordCount) {
    const remaining = wordCount - produced;
    const words = planningSentence(index).split(" ");
    index += 1;
    if (remaining <= words.length + MIN_FINAL_SEGMENT_WORDS) {
      // Last sentence: take exactly the remaining words (extend with the next
      // phrase when the natural sentence is shorter than the budget).
      const tail = [...words];
      while (tail.length < remaining) {
        tail.push(...planningSentence(index).split(" "));
        index += 1;
      }
      sentences.push(tail.slice(0, remaining).join(" "));
      produced += remaining;
      break;
    }
    sentences.push(words.join(" "));
    produced += words.length;
  }
  return sentences;
}

/**
 * Build the complete, duration-aligned narration script for one release.
 *
 *   { title, season?, episode?, targetDurationSeconds? }
 *
 * `targetDurationSeconds` must be one of the Director-configurable episode
 * targets (1800 / 2400 / 3000 — i.e. 30, 40, 50 minutes); anything else fails
 * closed with NARRATION_TARGET_UNSUPPORTED so a run can never quietly plan a
 * different length from the one QC will measure.
 *
 * Returns a frozen record:
 *   { scriptType, scriptVersion, generationMode, editorialStatus, language,
 *     title, targetSeconds, plannedSeconds, wordCount, estimatedSeconds,
 *     acceptanceWindow: { minSeconds, maxSeconds }, text, segments }
 *
 *   - plannedSeconds  sums the five beat segments exactly to the target.
 *   - estimatedSeconds is wordCount ÷ the documented planning rate and is
 *     aimed INSIDE the completeness gate's acceptance window for that target.
 *   - `text` is the complete script handed to the audio stage.
 */
export function buildNarrationScript({
  title,
  season = null,
  episode = null,
  targetDurationSeconds = DEFAULT_EPISODE_DURATION_SECONDS,
} = {}) {
  if (!EPISODE_DURATION_OPTIONS_SECONDS.includes(targetDurationSeconds)) {
    throw scriptError("NARRATION_TARGET_UNSUPPORTED");
  }
  const normalizedTitle = normalizeTitle(title);
  const targetSeconds = targetDurationSeconds;

  // Plan a little short of the target so the estimate sits away from the QC
  // window's upper edge (audio may not exceed the picture by more than 1 s).
  const tolerance = audioCoverageToleranceSeconds(targetSeconds);
  const aimSeconds = targetSeconds - Math.min(NARRATION_AIM_MARGIN_SECONDS, Math.max(1, tolerance));

  const titleWords = `इस कहानी का नाम है ${normalizedTitle}`.split(" ").length;
  const bodyWordBudget = Math.max(
    NARRATION_BEATS.length * MIN_FINAL_SEGMENT_WORDS,
    Math.round(aimSeconds * NARRATION_PLANNING_WORDS_PER_SECOND) - titleWords,
  );

  // Distribute the word budget over the five beats with the canonical
  // weights; the last beat absorbs the remainder so the sum is exact.
  const segmentSeconds = BEAT_WEIGHTS.map((weight) => Math.floor(targetSeconds * weight));
  segmentSeconds.push(targetSeconds - segmentSeconds.reduce((sum, value) => sum + value, 0));
  const segmentWords = BEAT_WEIGHTS.map((weight) => Math.floor(bodyWordBudget * weight));
  segmentWords.push(bodyWordBudget - segmentWords.reduce((sum, value) => sum + value, 0));

  const segments = NARRATION_BEATS.map((beat, index) => ({
    segment: index + 1,
    beat,
    plannedSeconds: segmentSeconds[index],
    wordCount: segmentWords[index],
    text: composeSegmentWords(segmentWords[index]).join(" "),
  }));

  const body = segments.map((segment) => segment.text).join(" ");
  const text = `इस कहानी का नाम है ${normalizedTitle}. ${body}`.replace(/\s+/g, " ").trim();
  const wordCount = text.split(" ").length;
  const estimatedSeconds = wordCount / NARRATION_PLANNING_WORDS_PER_SECOND;

  // The planning rate, in the units the synthesis stack can actually execute
  // (Issue #257): the audio stage passes this WORDS-PER-MINUTE request to the
  // executor, and measured calibration corrects the delta against reality.
  const wordsPerMinute = Math.round(NARRATION_PLANNING_WORDS_PER_SECOND * 60);

  return Object.freeze({
    scriptType: NARRATION_SCRIPT_TYPE,
    scriptVersion: NARRATION_SCRIPT_VERSION,
    generationMode: "deterministic_local",
    editorialStatus: "deterministic_planning_text",
    language: "hi",
    title: normalizedTitle,
    season,
    episode,
    targetSeconds,
    plannedSeconds: targetSeconds,
    wordsPerMinute,
    wordCount,
    estimatedSeconds,
    acceptanceWindow: Object.freeze({
      minSeconds: targetSeconds - tolerance,
      maxSeconds: targetSeconds + 1,
    }),
    text,
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
  });
}
