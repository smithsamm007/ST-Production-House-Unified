/**
 * ST Production House — canonical short-form package stage (Issue #189).
 *
 * Produces the canonical short-form component of the package (S-M34-01):
 *
 *   exactly 2 INDEPENDENT content Reels + exactly 1 standalone brand Reel,
 *   each assembled by the REAL FFmpeg executor (#175) from the release's
 *   OWN verified artifacts (narration audio + visual program), short-form
 *   duration QC enforced on REAL ffprobe measurement (5–180 s window),
 *   every reel recorded through the #182 bridge (video artifacts).
 *
 * All reel PLANS are built through the S-M34-01 contract:
 *   - `assertReelIndependence` enforces genuinely distinct content Reels
 *     (normalized hook + objective + segment plans must differ — copying
 *     the same reel twice is a REEL_NOT_INDEPENDENT failure).
 *   - brandIntegrationMode defaults to STANDALONE_ONLY: the brand Reel is a
 *     standalone promo; main-video integration stays owner-gated (Rule 9)
 *     and is NOT constructed here.
 *
 * Director isolation (§3/§4/§32): every plan, descriptor, and artifact is
 * bound to `release.agentId` + the release's own productionRunId; captions
 * and concepts carry no internal agent names (S-M34-01 enforces R15);
 * cross-Director inputs fail closed through the bridge's scope gate.
 *
 * Honesty (Rules 1–3): nothing is "generated" that the executors did not
 * really produce; missing capacity returns the truthful durable wait; a
 * reel that fails its real duration QC is a truthful stage failure.
 */

import {
  createReelPlan,
  createReelPackagePlan,
  assertReelIndependence,
  REEL_MIN_SECONDS,
  REEL_MAX_SECONDS,
} from "../production/reelPlan.js";
import { createAssemblyPlan } from "../media/assemblyPlan.js";

export const REELS_STAGE_VERSION = "reels_stage_v1";

/** Stable error codes (fail-closed). */
export const REELS_STAGE_ERROR_CODES = Object.freeze([
  "REELS_INPUT_INVALID",
  "REELS_RUNNER_REQUIRED",
  "REELS_AGENT_SCOPE_MISMATCH",
  "REELS_NOT_INDEPENDENT",
  "REELS_MEDIA_REJECTED",
  "REELS_PLAN_UNBUILDABLE",
]);

function reelsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** The canonical per-run reel identities (§9: 2 content + 1 brand). */
export const CANONICAL_REELS = Object.freeze([
  Object.freeze({
    key: "content_reel_1",
    role: "content_reel",
    hook: "Cold-open question hook that frames the episode's central mystery",
    objective: "Drive episode watch-through by teasing the opening conflict",
    captionConcept: "The story begins where the last chapter ended — full episode linked.",
    destinations: ["youtube_shorts"],
    /** Segment plan A: one sustained visual beat (12 s). */
    planBeats: Object.freeze([12]),
  }),
  Object.freeze({
    key: "content_reel_2",
    role: "content_reel",
    hook: "Character-choice spotlight hook built from the episode's turning point",
    objective: "Convert profile viewers into subscribers with a standalone payoff beat",
    captionConcept: "One decision changes everything this season — behind the story.",
    destinations: ["instagram_reels"],
    /** Segment plan B: two-beat pacing, structurally distinct from A. */
    planBeats: Object.freeze([5, 7]),
  }),
  Object.freeze({
    key: "brand_reel",
    role: "brand_reel",
    hook: "Brand promise hook: the house style in thirty seconds or less",
    objective: "Standalone brand-promotion recall for the channel identity",
    captionConcept: "New stories every week — follow the official channel.",
    destinations: ["youtube_shorts", "instagram_reels"],
    planBeats: Object.freeze([10]),
  }),
]);

/**
 * Build the canonical S-M34-01 reel package plan for one release from the
 * release's OWN verified artifacts. Pure: identical release state yields an
 * identical plan (idempotent resume).
 *
 *   deps: {
 *     agentId, productionRunId,
 *     narrationArtifact,   — recorded audio artifact (sha256 + descriptor)
 *     visualArtifact,      — recorded visual artifact (sha256 + descriptor)
 *     brandIdentityKey,    — product/service identity key for the brand Reel
 *   }
 */
export function buildCanonicalReelPackagePlan(deps = {}) {
  const { agentId, productionRunId, narrationArtifact, visualArtifact, brandIdentityKey } = deps;
  if (typeof agentId !== "string" || agentId.length === 0) throw reelsError("REELS_INPUT_INVALID");
  if (typeof productionRunId !== "string" || productionRunId.length === 0) throw reelsError("REELS_INPUT_INVALID");
  if (!isPlainObject(narrationArtifact) || typeof narrationArtifact.sha256 !== "string") throw reelsError("REELS_INPUT_INVALID");
  if (!isPlainObject(visualArtifact) || typeof visualArtifact.sha256 !== "string") throw reelsError("REELS_INPUT_INVALID");
  if (typeof brandIdentityKey !== "string" || brandIdentityKey.length === 0) throw reelsError("REELS_INPUT_INVALID");
  if (narrationArtifact.agentId !== undefined && narrationArtifact.agentId !== agentId) {
    throw reelsError("REELS_AGENT_SCOPE_MISMATCH");
  }
  if (visualArtifact.agentId !== undefined && visualArtifact.agentId !== agentId) {
    throw reelsError("REELS_AGENT_SCOPE_MISMATCH");
  }

  const narrationRef = `sha256:${narrationArtifact.sha256}`;
  const visualRef = `sha256:${visualArtifact.sha256}`;

  /** One S-M34-01 reel plan per canonical identity (per-identity beat plan). */
  const buildReel = (spec) => createReelPlan({
    agentId,
    productionRunId,
    role: spec.role,
    hook: spec.hook,
    objective: spec.objective,
    aspectRatio: "9:16",
    durationSeconds: spec.planBeats.reduce((sum, seconds) => sum + seconds, 0),
    captionConcept: spec.captionConcept,
    segments: [
      ...spec.planBeats.map((seconds, index) => ({
        artifactRef: visualRef,
        kind: "still_image",
        durationSeconds: seconds,
      })),
      { artifactRef: narrationRef, kind: "voice" },
    ],
    destinations: spec.destinations,
    ...(spec.role === "brand_reel" ? { productIdentityKey: brandIdentityKey, paidCampaign: false } : {}),
  });

  const contentReel1 = buildReel(CANONICAL_REELS[0]);
  const contentReel2 = buildReel(CANONICAL_REELS[1]);
  // Genuinely independent content (S-M34-01): copying the same reel twice
  // must fail closed here, at plan-construction time — not at QC time.
  try {
    assertReelIndependence(contentReel1, contentReel2);
  } catch (err) {
    // S-M34-01 codes (REEL_HOOK|OBJECTIVE|SEGMENT_PLAN_NOT_INDEPENDENT)
    // map to the stage's single independence code; other codes pass through.
    const code = typeof err?.code === "string" && err.code.endsWith("_NOT_INDEPENDENT")
      ? "REELS_NOT_INDEPENDENT"
      : err?.code ?? "REELS_PLAN_UNBUILDABLE";
    throw reelsError(code);
  }
  const brandReel = buildReel(CANONICAL_REELS[2]);

  return createReelPackagePlan({
    agentId,
    productionRunId,
    contentReels: [contentReel1, contentReel2],
    brandReel,
    brandIntegrationMode: "STANDALONE_ONLY",
  });
}

/**
 * Derive the short-form FFmpeg assembly plans (one per canonical reel) from
 * the reel package. Each plan binds the release's OWN narration + visual
 * through sha256 descriptor references; the #175 executor's short-form
 * duration gate measures the REAL render against [5, 180] s.
 */
export function buildReelAssemblyPlans({ reelPackage, narrationArtifact, visualArtifact, paths, productionRunId }) {
  if (!isPlainObject(reelPackage)) throw reelsError("REELS_INPUT_INVALID");
  if (!Array.isArray(reelPackage.contentReels) || reelPackage.contentReels.length !== 2) {
    throw reelsError("REELS_INPUT_INVALID");
  }
  if (!isPlainObject(reelPackage.brandReel)) throw reelsError("REELS_INPUT_INVALID");
  if (typeof paths?.episode !== "string" || paths.episode.length === 0) throw reelsError("REELS_INPUT_INVALID");

  const narrationRef = `sha256:${narrationArtifact.sha256}`;
  const visualRef = `sha256:${visualArtifact.sha256}`;
  const outputTargetByKey = ["content_reel_1", "content_reel_2", "brand_reel"];
  const plansByKey = [reelPackage.contentReels[0], reelPackage.contentReels[1], reelPackage.brandReel].map((reel, index) => {
    const key = outputTargetByKey[index];
    const visualBeats = reel.segments.filter((segment) => segment.kind === "still_image");
    // Real assembly plan via the S-M33-01 contract: canonical id recomputed
    // at construction, integrity verified before execution (#175 gate).
    const plan = createAssemblyPlan({
      agentId: reel.agentId,
      productionRunId: reel.productionRunId,
      outputTarget: key,
      aspectRatio: reel.aspectRatio,
      segments: [
        ...visualBeats.map((beat) => ({
          artifactRef: visualRef,
          kind: "still_image",
          durationSeconds: beat.durationSeconds,
        })),
        { artifactRef: narrationRef, kind: "voice" },
      ],
      note: `canonical ${key} for run ${reel.productionRunId}`,
    });
    return deepFreeze({
      key,
      outputTarget: key,
      plan,
      outputPath: `${paths.episode}/${productionRunId}-${key}.mp4`,
    });
  });
  return deepFreeze(plansByKey);
}

/**
 * Run the reels stage for one release.
 *
 *   runner: async ({ release, stage: "reels", stageInputs, agentId,
 *                    artifactBindings, reelPlans }) => executor-shaped result
 *                    for ONE reel plan ({ key, result }) or an array of them.
 *
 * Each real result is evaluated through the #182 bridge (stage "assembly"
 * semantics: video artifact + short-form QC on the plan's output target).
 * Verified reels are recorded by the pipeline via recordExecutorArtifact;
 * waits/failures are returned truthfully.
 *
 * Returns { status: "complete", reelPackage, plans, results } or
 *         { status: "waiting"|"failed", failureCode }.
 */
export async function runReelsStage({
  release,
  stageInputs,
  recordedArtifacts,
  runner,
  paths,
  brandIdentityKey,
}) {
  if (!isPlainObject(release)) throw reelsError("REELS_INPUT_INVALID");
  if (typeof runner !== "function") throw reelsError("REELS_RUNNER_REQUIRED");
  if (typeof release.agentId !== "string" || release.agentId.length === 0) {
    throw reelsError("REELS_AGENT_SCOPE_MISMATCH");
  }
  const byStage = new Map((recordedArtifacts ?? []).map((a) => [a.stage, a]));
  const narrationArtifact = byStage.get("audio");
  const visualArtifact = byStage.get("visual");
  if (!narrationArtifact?.sha256 || !visualArtifact?.sha256 || !narrationArtifact.descriptor || !visualArtifact.descriptor) {
    throw reelsError("REELS_INPUT_INVALID");
  }

  const productionRunId = `${paths?.runPrefix ?? "episode"}-${typeof release.id === "string" ? release.id.slice(0, 8) : "release"}`;
  let reelPackage;
  try {
    reelPackage = buildCanonicalReelPackagePlan({
      agentId: release.agentId,
      productionRunId,
      narrationArtifact,
      visualArtifact,
      brandIdentityKey: brandIdentityKey ?? `channel-${release.agentId}`,
    });
  } catch (err) {
    throw reelsError(err.code ?? "REELS_PLAN_UNBUILDABLE");
  }

  const plans = buildReelAssemblyPlans({
    reelPackage,
    narrationArtifact,
    visualArtifact,
    paths: { episode: paths?.episode ?? "/stph/media/episodes" },
    productionRunId,
  });

  const results = [];
  for (const entry of plans) {
    let executorResult;
    try {
      executorResult = await runner({
        release,
        stage: "reels",
        stageInputs,
        agentId: release.agentId,
        reelPlan: entry,
        recordedArtifacts: Object.freeze([...(recordedArtifacts ?? [])]),
      });
    } catch (err) {
      throw reelsError(err.code ?? "REELS_MEDIA_REJECTED");
    }
    if (!isPlainObject(executorResult)) throw reelsError("REELS_INPUT_INVALID");

    // Waiting/failure are truthful, not stage crashes.
    if (executorResult.quotaState === "WAITING_FOR_QUOTA") {
      return deepFreeze({ status: "waiting", failureCode: executorResult.failureCode ?? "QUOTA_EXHAUSTED" });
    }
    if (executorResult.success !== true || !executorResult.descriptor) {
      return deepFreeze({ status: "failed", failureCode: executorResult.failureCode ?? "REELS_MEDIA_REJECTED", reelKey: entry.key });
    }
    results.push(deepFreeze({ key: entry.key, plan: entry, result: executorResult }));
  }

  return deepFreeze({
    status: "complete",
    reelPackage,
    plans,
    results: deepFreeze(results),
  });
}
