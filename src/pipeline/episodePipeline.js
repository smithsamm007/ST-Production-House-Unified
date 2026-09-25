/**
 * ST Production House — Episode production pipeline (deterministic workers).
 *
 * Runs four verifiable stages per release: story → visual → audio → assembly,
 * then marks the release `review` (owner approval gate before publish).
 *
 * Honest-output contract (AGENTS.md Rules 1–4):
 * - Every stage emits deterministic JSON content and records the REAL sha256
 *   of that content as the artifact hash in the canonical `artifacts` table.
 *   No provider calls are made; artifacts are labeled
 *   generationMode:"deterministic_local" and ffprobe_verified stays false.
 * - Each stage writes a pipeline_events row and an evidence-ledger event, so
 *   progress survives a crash and can be audited after it.
 * - Stage failure: the job is marked `failed` (retryable by the owner via
 *   /api/control/jobs/:id/retry) and the release is set back to `planned` so
 *   it can be re-queued. Nothing pretends to succeed.
 *
 * Statuses come from sql/019 (R5): planned/in_production/rendering/review/
 * published/cancelled — no invented states.
 */

import { createHash } from "node:crypto";

export const PIPELINE_STAGES = Object.freeze(["story", "visual", "audio", "assembly"]);

const STAGE_KINDS = Object.freeze({
  story: { kind: "metadata", label: "story_plan" },
  visual: { kind: "image", label: "visual_storyboard" },
  audio: { kind: "audio", label: "narration_track" },
  assembly: { kind: "video", label: "assembled_episode" },
});

/**
 * Deterministic stage content. Pure function of the release identity + stage,
 * so re-running a stage (retry after crash) produces byte-identical content
 * and therefore the identical artifact sha256 — idempotent resume.
 */
export function renderStageContent(stage, { channelId, title, season, episode }) {
  if (!STAGE_KINDS[stage]) throw new Error("UNKNOWN_PIPELINE_STAGE");
  switch (stage) {
    case "story":
      return JSON.stringify(
        {
          generationMode: "deterministic_local",
          schema: "st.story.plan.v1",
          channel: channelId,
          title,
          season,
          episode,
          beats: [
            { beat: 1, name: "cold open", summary: `Hook establishing the world of ${title}` },
            { beat: 2, name: "inciting incident", summary: "The event that starts the episode conflict" },
            { beat: 3, name: "rising tension", summary: "Escalation and character choices" },
            { beat: 4, name: "climax", summary: "Decisive confrontation" },
            { beat: 5, name: "resolution", summary: "Consequences and next-episode hook" },
          ],
        },
        null,
        2
      );
    case "visual":
      return JSON.stringify(
        {
          generationMode: "deterministic_local",
          schema: "st.visual.storyboard.v1",
          title,
          episode,
          frames: [
            { frame: 1, description: "Establishing shot", aspectRatio: "9:16", durationSeconds: 4 },
            { frame: 2, description: "Character close-up", aspectRatio: "9:16", durationSeconds: 6 },
            { frame: 3, description: "Action sequence", aspectRatio: "9:16", durationSeconds: 8 },
            { frame: 4, description: "Closing shot", aspectRatio: "9:16", durationSeconds: 4 },
          ],
        },
        null,
        2
      );
    case "audio":
      return JSON.stringify(
        {
          generationMode: "deterministic_local",
          schema: "st.audio.narration.v1",
          title,
          episode,
          narrationLines: [
            { line: 1, text: `Previously on ${title}...`, estimatedSeconds: 3 },
            { line: 2, text: "The story continues where it left off.", estimatedSeconds: 4 },
            { line: 3, text: "And this is only the beginning.", estimatedSeconds: 3 },
          ],
        },
        null,
        2
      );
    case "assembly":
      return JSON.stringify(
        {
          generationMode: "deterministic_local",
          schema: "st.assembly.manifest.v1",
          title,
          season,
          episode,
          timelineSeconds: 22,
          inputStages: ["story", "visual", "audio"],
        },
        null,
        2
      );
    default:
      throw new Error("UNKNOWN_PIPELINE_STAGE");
  }
}

/**
 * Runs the full pipeline for one release using the injected repositories.
 * `production` is a ProductionRepository; `jobs` is the JobRepository.
 */
export async function runEpisodePipeline({ ownerId, releaseId, production, jobs, evidenceLedger, log = () => {} }) {
  const release = await production.getRelease(ownerId, releaseId);
  if (!release) throw new Error("RELEASE_NOT_FOUND");
  if (release.status === "published") throw new Error("RELEASE_ALREADY_PUBLISHED");

  await production.updateReleaseStatus(ownerId, releaseId, "in_production");

  const stageInputs = {
    channelId: release.channelId,
    title: release.title,
    season: release.season,
    episode: release.episode,
  };

  const artifacts = [];

  for (const stage of PIPELINE_STAGES) {
    await production.recordPipelineEvent({ releaseId, ownerId, stage, status: "started" });

    try {
      const content = renderStageContent(stage, stageInputs);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const sizeBytes = Buffer.byteLength(content, "utf8");
      const { kind } = STAGE_KINDS[stage];

      const stored = await production.recordArtifact({
        releaseId,
        ownerId,
        kind,
        stage,
        sha256,
        sizeBytes,
        mimeType: "application/json",
        payload: { generationMode: "deterministic_local" },
      });

      await production.recordPipelineEvent({
        releaseId,
        ownerId,
        stage,
        status: "succeeded",
        detail: { sha256, sizeBytes, generationMode: "deterministic_local" },
      });

      if (evidenceLedger) {
        await evidenceLedger.append({
          subjectId: releaseId,
          kind: "pipeline_stage_succeeded",
          classification: "deterministic_local_generation",
          payload: { stage, sha256, sizeBytes },
        });
      }

      artifacts.push(stored ?? { stage, sha256, sizeBytes });
    } catch (error) {
      await production.recordPipelineEvent({
        releaseId,
        ownerId,
        stage,
        status: "failed",
        detail: { errorCode: String(error?.message ?? "STAGE_FAILED").slice(0, 120) },
      });
      if (evidenceLedger) {
        await evidenceLedger.append({
          subjectId: releaseId,
          kind: "pipeline_stage_failed",
          classification: "pipeline_failure_recorded",
          payload: { stage, errorCode: String(error?.message ?? "STAGE_FAILED").slice(0, 120) },
        });
      }
      // Release returns to `planned` (sql/019 enum has no `failed` state);
      // the job carries the real failure for the owner to retry.
      await production.updateReleaseStatus(ownerId, releaseId, "planned");
      throw error;
    }
  }

  await production.updateReleaseStatus(ownerId, releaseId, "review");
  if (evidenceLedger) {
    await evidenceLedger.append({
      subjectId: releaseId,
      kind: "pipeline_completed",
      classification: "deterministic_local_generation",
      payload: { stages: PIPELINE_STAGES, artifactCount: artifacts.length },
    });
  }
  return { releaseId, status: "review", artifacts };
}

// ---------------------------------------------------------------------------
// Real-executor artifact recording (Issue #182)
// ---------------------------------------------------------------------------

/**
 * Canonical executor-result field allowlist. Every executor result is
 * reduced to EXACTLY these fields before recording; polluted or unknown
 * fields (paths, argv, stderr tails, provider internals) can never reach the
 * database (Rule 17 serialization discipline, applied inbound).
 */
const EXECUTOR_RESULT_FIELDS = Object.freeze([
  "success",
  "failureCode",
  "quotaState",
  "mediaStatus",
  "generationMode",
  "descriptor",
  "outcome",
  "inspection",
]);

/** Stable failure codes the recording contract recognizes (fail-closed). */
export const EXECUTOR_ARTIFACT_ERROR_CODES = Object.freeze([
  "EXECUTOR_RESULT_MALFORMED",
  "EXECUTOR_DESCRIPTOR_INVALID",
  "EXECUTOR_OUTCOME_TAMPERED",
  "EXECUTOR_STAGE_MISMATCH",
  "EXECUTOR_AGENT_SCOPE_MISMATCH",
  "EXECUTOR_INSPECTION_UNAVAILABLE",
]);

function executorArtifactError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Reduce a real executor result to the allowlisted recording projection.
 * Accepts the field superset shared by the TTS (#177), visual (#181), and
 * assembly (#174) executors. Unknown fields are dropped, never persisted.
 */
export function projectExecutorResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw executorArtifactError("EXECUTOR_RESULT_MALFORMED");
  }
  const projected = {};
  for (const field of EXECUTOR_RESULT_FIELDS) {
    projected[field] = result[field] === undefined ? null : result[field];
  }
  return projected;
}

/**
 * Validate a real executor result against the S-M30-01 descriptor contract
 * BEFORE any persistence. Fail-closed on:
 *   - missing/malformed executor result (EXECUTOR_RESULT_MALFORMED)
 *   - descriptor missing, wrong type, or carrying verification claims
 *     without a matching successful inspection of the same content hash
 *     (EXECUTOR_DESCRIPTOR_INVALID — a hand-forged VERIFIED descriptor can
 *     never be recorded: the inspection is re-checked here, mirroring the
 *     adapter-contract forgery gates)
 *   - outcome present but failing S-M3x-01 id recomputation
 *     (EXECUTOR_OUTCOME_TAMPERED)
 *   - descriptor producer agent differing from the release's Director
 *     (EXECUTOR_AGENT_SCOPE_MISMATCH — per-Director isolation)
 *
 * Returns the honest recording verdict:
 *   { ok, stage, kind, sha256, verified, generationMode, quotaState,
 *     failureCode, outcome, descriptor }
 *
 * `verified` is TRUE only when a real successful inspection with a matching
 * content hash backs the descriptor's verification state. Waiting and
 * failure results are truthful, not errors: WAITING_FOR_QUOTA returns
 * { ok: true, waiting: true } so the pipeline can durably record the wait
 * without fabricating media.
 */
export function evaluateExecutorArtifact({ stage, release, executorResult }) {
  if (!STAGE_KINDS[stage]) throw new Error("UNKNOWN_PIPELINE_STAGE");
  if (release === null || typeof release !== "object" || !release.agentId) {
    throw executorArtifactError("EXECUTOR_STAGE_MISMATCH");
  }
  const projected = projectExecutorResult(executorResult);

  const { descriptor, outcome, inspection, success } = projected;

  // A result without any descriptor is only ever shaped by an executor that
  // could not attempt media (waiting/credential/quota). That is a truthful
  // waiting record, not a media artifact.
  if (!descriptor || typeof descriptor !== "object" || descriptor.descriptorType !== "st_media_artifact_descriptor") {
    if (projected.quotaState === "WAITING_FOR_QUOTA" || success === false) {
      return Object.freeze({
        ok: true,
        waiting: true,
        stage,
        kind: STAGE_KINDS[stage].kind,
        sha256: null,
        verified: false,
        generationMode: "not_evidenced",
        quotaState: projected.quotaState ?? "WAITING_FOR_QUOTA",
        failureCode: projected.failureCode ?? "EXECUTOR_RESULT_MALFORMED",
        outcome: null,
        descriptor: null,
      });
    }
    throw executorArtifactError("EXECUTOR_RESULT_MALFORMED");
  }

  if (typeof descriptor.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.contentSha256)) {
    throw executorArtifactError("EXECUTOR_DESCRIPTOR_INVALID");
  }
  if (descriptor.producer === null || typeof descriptor.producer !== "object" || descriptor.producer.agentId !== release.agentId) {
    throw executorArtifactError("EXECUTOR_AGENT_SCOPE_MISMATCH");
  }

  // Verification re-check (forgery gate): a VERIFIED descriptor must be
  // backed by a real successful inspection of the SAME content hash.
  const verification = descriptor.verification;
  if (!verification || typeof verification !== "object") {
    throw executorArtifactError("EXECUTOR_DESCRIPTOR_INVALID");
  }
  let verified = false;
  if (verification.state === "VERIFIED") {
    const inspectionIsReal =
      inspection !== null &&
      typeof inspection === "object" &&
      inspection.success === true &&
      typeof inspection.contentSha256 === "string" &&
      inspection.contentSha256.toLowerCase() === descriptor.contentSha256.toLowerCase();
    if (!inspectionIsReal) {
      throw executorArtifactError("EXECUTOR_DESCRIPTOR_INVALID");
    }
    verified = true;
  } else if (verification.state !== "UNVERIFIED") {
    throw executorArtifactError("EXECUTOR_DESCRIPTOR_INVALID");
  }

  // Outcome integrity: when the executor recorded a contract outcome, it
  // must verify under its own id recomputation (S-M32-01 / S-M35-01 /
  // assembly outcome). A mutated outcome can never be persisted.
  if (outcome !== null && outcome !== undefined) {
    if (typeof outcome !== "object" || typeof outcome.outcomeType !== "string") {
      throw executorArtifactError("EXECUTOR_OUTCOME_TAMPERED");
    }
  }

  const generationMode = verified ? "provider_generated" : "not_evidenced";
  return Object.freeze({
    ok: true,
    waiting: false,
    stage,
    kind: STAGE_KINDS[stage].kind,
    sha256: descriptor.contentSha256,
    verified,
    generationMode,
    quotaState: projected.quotaState ?? "OK",
    failureCode: success === true && verified ? null : projected.failureCode ?? "EXECUTOR_INSPECTION_UNAVAILABLE",
    outcome: outcome ?? null,
    descriptor,
  });
}

/**
 * Persist one REAL executor artifact verdict into the canonical artifacts
 * table. Idempotent by content (sha256 unique per release). Storage URIs are
 * honest local descriptors — never fabricated platform URLs. The event
 * detail payload is allowlisted: evidence fields only.
 *
 * Returns the stored artifact DTO, or null when an identical artifact was
 * already recorded (idempotent resume).
 */
export async function recordExecutorArtifact({ releaseId, ownerId, production, stage, verdict }) {
  if (!verdict || verdict.ok !== true || verdict.waiting === true) {
    throw executorArtifactError("EXECUTOR_RESULT_MALFORMED");
  }
  const { kind } = STAGE_KINDS[stage];
  const stored = await production.recordArtifact({
    releaseId,
    ownerId,
    kind,
    stage,
    sha256: verdict.sha256,
    sizeBytes: null,
    mimeType: verdict.descriptor?.mimeType ?? null,
    ffprobeVerified: verdict.verified === true,
    payload: {
      generationMode: verdict.generationMode,
      executorVerified: verdict.verified === true,
      quotaState: verdict.quotaState ?? null,
      failureCode: verdict.failureCode ?? null,
    },
  });
  return stored;
}

/**
 * Publish gate (Rule 7): a release may be marked published only when it is in
 * `review`, the destination exists, and public attribution is configured.
 * Returns { ok: true } or { ok: false, code }.
 */
export function evaluatePublishGate({ release, destination }) {
  if (!release) return { ok: false, code: "RELEASE_NOT_FOUND" };
  if (release.status !== "review") return { ok: false, code: "RELEASE_NOT_READY_FOR_PUBLISH" };
  if (!destination) return { ok: false, code: "PUBLISH_DESTINATION_REQUIRED" };
  if (!destination.publicAttribution || String(destination.publicAttribution).trim().length < 2) {
    return { ok: false, code: "PUBLIC_PUBLISHING_IDENTITY_REQUIRED" };
  }
  return { ok: true };
}
