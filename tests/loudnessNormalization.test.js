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
  buildMeasuredNormalizationFilter,
  requiresCorrectiveNormalization,
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
