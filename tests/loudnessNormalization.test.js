/**
 * Focused regression test for the rehearsed-delivery loudness contract
 * (Issue #264 follow-up, failure observed in run 43301281602).
 *
 * It pins the two facts that failure exposed:
 *
 *   1. The completeness gate is fed the measurement of the DELIVERED file.
 *      The real run reported true peak +0.14 dBTP on `episode.mp4` while the
 *      intermediate normalized WAV was still inside its own target; a gate
 *      fed either the raw synthesis or the normalized WAV would have reported
 *      a pass for bytes that were never delivered.
 *   2. The delivery pass leaves headroom below the published QC limit, and it
 *      is a two-pass linear pass driven by real measurements, so an AAC encode
 *      cannot push the deliverable back over the contract.
 *
 * These are pure-logic assertions (no ffmpeg required); the real-encoder proof
 * is the Rehearsal Evidence workflow re-run that must retain an artifact.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_TARGET_LUFS,
  DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  QC_MAX_TRUE_PEAK_DBTP,
  buildDynamicDeliveryFilter,
  buildMeasuredNormalizationFilter,
  requiresCorrectiveNormalization,
  planCorrectiveRound,
  planDeliveryAttenuation,
  selectGateLoudness,
} from "../src/media/loudnessNormalization.js";

const measuredInput = Object.freeze({
  integratedLufs: -18.62,
  truePeakDbtp: 0.14,
  loudnessRangeLu: 1,
  thresholdLufs: -29.11,
});

test("the delivery peak target leaves real headroom below the QC contract", () => {
  assert.equal(QC_MAX_TRUE_PEAK_DBTP, -1.0);
  assert.ok(
    DELIVERY_TRUE_PEAK_HEADROOM_DBTP < QC_MAX_TRUE_PEAK_DBTP,
    `delivery target ${DELIVERY_TRUE_PEAK_HEADROOM_DBTP} dBTP must sit below the QC limit ${QC_MAX_TRUE_PEAK_DBTP} dBTP`,
  );
  assert.equal(DELIVERY_TARGET_LUFS, -14.0);
});

test("the applying pass is two-pass, linear and driven by the real measurement", () => {
  const filter = buildMeasuredNormalizationFilter({ measured: measuredInput });
  assert.match(filter, /^loudnorm=/);
  assert.match(filter, new RegExp(`TP=${DELIVERY_TRUE_PEAK_HEADROOM_DBTP}`));
  assert.match(filter, /I=-14/);
  assert.match(filter, /measured_I=-18\.62/);
  assert.match(filter, /measured_TP=0\.14/);
  assert.match(filter, /measured_LRA=1/);
  assert.match(filter, /measured_thresh=-29\.11/);
  assert.match(filter, /linear=true/);
});

test("the applying pass refuses an incomplete measurement instead of guessing", () => {
  assert.throws(
    () => buildMeasuredNormalizationFilter({ measured: { integratedLufs: -18.62 } }),
    (error) => error.code === "LOUDNESS_MEASUREMENT_INVALID",
  );
  assert.throws(
    () => buildMeasuredNormalizationFilter({}),
    (error) => error.code === "LOUDNESS_MEASUREMENT_REQUIRED",
  );
});

test("a delivered file above the QC true peak is flagged for correction, one inside it is not", () => {
  // The exact measured values from the failed real run.
  assert.equal(requiresCorrectiveNormalization({ truePeakDbtp: 0.14 }), true);
  assert.equal(requiresCorrectiveNormalization({ truePeakDbtp: -1.0 }), false);
  assert.equal(requiresCorrectiveNormalization({ truePeakDbtp: -2.48 }), false);
  assert.throws(
    () => requiresCorrectiveNormalization({}),
    (error) => error.code === "LOUDNESS_MEASUREMENT_INVALID",
  );
});

test("the completeness gate receives the delivered file measurement, never a pre-normalization one", () => {
  const assembled = { integratedLufs: -15.47, truePeakDbtp: 0.14, clippingCount: 1 };
  const rawSpeech = { integratedLufs: -18.62, truePeakDbtp: 0.14, clippingCount: 1 };
  const normalizedSpeech = { integratedLufs: -14.02, truePeakDbtp: -2.51, clippingCount: 0 };

  const gateLoudness = selectGateLoudness({ assembled, rawSpeech, normalizedSpeech });
  assert.equal(gateLoudness, assembled, "the gate must receive the assembled/delivered measurement object");
  assert.equal(gateLoudness.truePeakDbtp, assembled.truePeakDbtp);
  assert.notEqual(gateLoudness, normalizedSpeech);
  assert.notEqual(gateLoudness, rawSpeech);
});

test("a missing delivered measurement fails closed rather than falling back to a pre-normalization value", () => {
  assert.throws(
    () =>
      selectGateLoudness({
        normalizedSpeech: { integratedLufs: -14.02, truePeakDbtp: -2.51 },
        rawSpeech: { integratedLufs: -18.62, truePeakDbtp: 0.14 },
      }),
    (error) => error.code === "REHEARSAL_DELIVERED_LOUDNESS_REQUIRED",
  );
});

test("a delivered file already inside the target converges with zero attenuation", () => {
  const plan = planDeliveryAttenuation({ measuredTruePeakDbtp: -2.6, targetTruePeakDbtp: -2.5 });
  assert.equal(plan.converged, true);
  assert.equal(plan.additionalAttenuationDb, 0);
  assert.equal(plan.cumulativeGainDb, 0);
});

test("an encoded overshoot is corrected from the MEASURED delivered file, with margin", () => {
  // Run 43921087702 measured +2.04 dBTP on the delivered AAC file. The plan
  // must derive attenuation from that number, not from the intermediate WAV.
  const plan = planDeliveryAttenuation({ measuredTruePeakDbtp: 2.04, targetTruePeakDbtp: -2.5 });
  assert.equal(plan.converged, false);
  assert.equal(plan.additionalAttenuationDb, -4.74);
  assert.equal(plan.cumulativeGainDb, -4.74);
});

test("attenuation accumulates across rounds and stops at the documented budget", () => {
  const first = planDeliveryAttenuation({ measuredTruePeakDbtp: 1.0, targetTruePeakDbtp: -2.5 });
  const second = planDeliveryAttenuation({
    measuredTruePeakDbtp: -1.8,
    targetTruePeakDbtp: -2.5,
    cumulativeGainDb: first.cumulativeGainDb,
  });
  assert.equal(second.cumulativeGainDb, -4.6);
  assert.throws(
    () => planDeliveryAttenuation({ measuredTruePeakDbtp: 6.0, targetTruePeakDbtp: -2.5, cumulativeGainDb: -8.0 }),
    (error) => error.code === "LOUDNESS_ATTENUATION_EXHAUSTED",
  );
});

test("the corrective planner refuses non-measured input and invalid budgets", () => {
  assert.throws(() => planDeliveryAttenuation({}), (error) => error.code === "LOUDNESS_MEASUREMENT_INVALID");
  assert.throws(
    () => planDeliveryAttenuation({ measuredTruePeakDbtp: 1, targetTruePeakDbtp: -2.5, maxCumulativeAttenuationDb: 0 }),
    (error) => error.code === "LOUDNESS_TARGET_INVALID",
  );
});

test("the corrective delivery filter targets loudness and a reduced peak ceiling together", () => {
  assert.equal(
    buildDynamicDeliveryFilter({ targetLufs: -14, truePeakDbtp: -2.5 }),
    "loudnorm=I=-14:TP=-2.5:LRA=7",
  );
  assert.equal(
    buildDynamicDeliveryFilter({ targetLufs: -14, truePeakDbtp: -7.24 }),
    "loudnorm=I=-14:TP=-7.24:LRA=7",
  );
  assert.throws(
    () => buildDynamicDeliveryFilter({ targetLufs: -14, truePeakDbtp: -2.5, loudnessRangeLu: 0 }),
    (error) => error.code === "LOUDNESS_TARGET_INVALID",
  );
});

test("the corrective controller converges only when loudness AND true peak are inside target", () => {
  const plan = planCorrectiveRound({ delivered: { integratedLufs: -14.4, truePeakDbtp: -2.6 } });
  assert.equal(plan.converged, true);
  assert.equal(plan.reasonCode, null);
});

test("a delivered peak over target lowers the ceiling and starts reducing loudness range", () => {
  // Measured in run 44068972407 round 1: ceiling -2.5 → delivered +2.04 dBTP.
  const plan = planCorrectiveRound({
    delivered: { integratedLufs: -15.91, truePeakDbtp: 2.04 },
    ceilingDbtp: -2.5,
    loudnessRangeLu: 7,
  });
  assert.equal(plan.converged, false);
  assert.equal(plan.nextCeilingDbtp, -7.24);
  assert.equal(plan.nextLoudnessRangeLu, 6);
});

test("a quiet program with an acceptable peak is fixed by compressing, not by more attenuation", () => {
  // A quiet program whose peak is already inside target: only compression helps.
  const plan = planCorrectiveRound({
    delivered: { integratedLufs: -20.3, truePeakDbtp: -2.6 },
    ceilingDbtp: -7.24,
    loudnessRangeLu: 7,
  });
  assert.equal(plan.converged, false);
  assert.equal(plan.nextCeilingDbtp, -7.24);
  assert.equal(plan.nextLoudnessRangeLu, 5);
});

test("the controller reports unreachable loudness and unreachable peak instead of looping", () => {
  const quiet = planCorrectiveRound({
    delivered: { integratedLufs: -20.3, truePeakDbtp: -3.0 },
    loudnessRangeLu: 1,
  });
  assert.equal(quiet.reasonCode, "DELIVERY_LOUDNESS_UNREACHABLE");

  const peaky = planCorrectiveRound({
    delivered: { integratedLufs: -14.0, truePeakDbtp: 3.0 },
    ceilingDbtp: -19.5,
  });
  assert.equal(peaky.reasonCode, "DELIVERY_PEAK_UNREACHABLE");
});
