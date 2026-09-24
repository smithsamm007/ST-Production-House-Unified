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
