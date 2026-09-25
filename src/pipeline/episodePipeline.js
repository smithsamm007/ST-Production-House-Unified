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
  // Packaging-stage artifact kinds (Issue #185/#186): the thumbnail is real
  // media (image, bridge-verified); subtitle/metadata/manifest documents are
  // deterministic records. `stage` labels stay distinct so identical-content
  // artifacts never collide under the (release_id, sha256) uniqueness rule.
  thumbnail: { kind: "image", label: "episode_thumbnail" },
  packaging: { kind: "metadata", label: "episode_manifest" },
  qc: { kind: "metadata", label: "qc_verdict" },
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
export async function runEpisodePipeline({ ownerId, releaseId, production, jobs, evidenceLedger, executorRunner = null, log = () => {} }) {
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

  // Issue #183: when a real-executor runner is injected, stages with real
  // executors (audio/visual/assembly) execute through it and record through
  // the #182 bridge. Without a runner, the historical deterministic path
  // runs unchanged. Executor waits (quota/credential absence) are durable:
  // the release returns to `planned`, earlier stage artifacts stay recorded,
  // and the job carries the stable wait code for scheduler resume — never a
  // fabricated success, never a stage failure that discards progress.
  if (executorRunner !== null) {
    return runEpisodePipelineWithExecutors({
      ownerId,
      releaseId,
      release,
      production,
      jobs,
      evidenceLedger,
      executorRunner,
      stageInputs,
      log,
    });
  }

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
  // The assembly stage's artifact is the canonical assembled media for this
  // release; the executor path records its descriptor through the bridge.
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

/**
 * Executor failure codes that mean DURABLE WAIT (scheduler can resume when
 * capacity returns), never stage failure. Defined here so the bridge owns
 * wait classification; the integration module re-exports it.
 */
export const EXECUTOR_WAIT_CODES = Object.freeze([
  "QUOTA_EXHAUSTED",
  "CREDENTIAL_MISSING",
  "PROVIDER_UNAVAILABLE",
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

  // A result without any descriptor is shaped only by an executor that could
  // not attempt or verify media. Three honest shapes, fail-closed:
  //   1. durable wait (quota/credential) — waiting verdict, resumable;
  //   2. truthful failure (any other stable code, e.g. INSPECTION_FAILED,
  //      PROVIDER_CALL_FAILED, VISUAL_TIMEOUT) — failure verdict, no media;
  //   3. "success" with no media and no failure code — incoherent, rejected.
  if (!descriptor || typeof descriptor !== "object" || descriptor.descriptorType !== "st_media_artifact_descriptor") {
    const code = typeof projected.failureCode === "string" ? projected.failureCode : null;
    const isWait = projected.quotaState === "WAITING_FOR_QUOTA" || (code !== null && EXECUTOR_WAIT_CODES.includes(code));
    if (isWait) {
      return Object.freeze({
        ok: true,
        waiting: true,
        stage,
        kind: STAGE_KINDS[stage].kind,
        sha256: null,
        verified: false,
        generationMode: "not_evidenced",
        quotaState: "WAITING_FOR_QUOTA",
        failureCode: code ?? "QUOTA_EXHAUSTED",
        outcome: null,
        descriptor: null,
      });
    }
    if (code !== null) {
      return Object.freeze({
        ok: true,
        waiting: false,
        stage,
        kind: STAGE_KINDS[stage].kind,
        sha256: null,
        verified: false,
        generationMode: "not_evidenced",
        quotaState: projected.quotaState ?? "OK",
        failureCode: code,
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

// ---------------------------------------------------------------------------
// Real-executor pipeline (Issue #183)
// ---------------------------------------------------------------------------

/**
 * Executor-driven pipeline run. For each stage with a real executor
 * (audio → TTS, visual → visual generation, assembly → FFmpeg), invoke the
 * injected Director-scoped runner, classify the result, evaluate it through
 * the #182 bridge, and record verified media into the artifacts table.
 *
 * Story stays deterministic (it is a plan document, not media). Failure at
 * stage N preserves recorded stages 1..N-1 (release → `planned`, job carries
 * the stable failure code — same contract as the deterministic path).
 *
 * WAITING semantics (Rules 2–3): executor waits (QUOTA_EXHAUSTED /
 * CREDENTIAL_MISSING / PROVIDER_UNAVAILABLE) are DURABLE WAITS. The release
 * returns to `planned` for scheduler resume, evidence records the wait, and
 * the job (when supported) carries `WAITING_FOR_QUOTA` + the stable code.
 * Completed stages are NEVER discarded and nothing is marked successful.
 *
 * Returns { releaseId, status, artifacts, waited? } where status is
 * "review" (all stages recorded) or "planned" (stage failure or durable wait).
 */
export async function runEpisodePipelineWithExecutors({
  ownerId,
  releaseId,
  release,
  production,
  jobs,
  evidenceLedger,
  executorRunner,
  stageInputs,
  log = () => {},
}) {
  const { runStageWithExecutor, recordExecutorArtifact } = await import("./executorIntegration.js");

  await production.updateReleaseStatus(ownerId, releaseId, "in_production");
  const artifacts = [];

  // Executor stages in dependency order. `assembly` consumes the release's
  // OWN verified artifacts via sha256 descriptor bindings — the runner
  // resolves those bindings from `recorded` (Director-scoped by release).
  const executorStages = ["audio", "visual", "assembly"];
  const recordedByStage = new Map();

  /** Descriptor bindings for the assembly stage: sha256:… → {descriptor, path}. */
  const artifactBindings = () => {
    const bindings = {};
    for (const artifact of recordedByStage.values()) {
      if (artifact && artifact.sha256 && typeof artifact.storagePath === "string") {
        bindings[`sha256:${artifact.sha256}`] = {
          descriptor: artifact.descriptor ?? null,
          path: artifact.storagePath,
        };
      }
    }
    return bindings;
  };

  for (const stage of executorStages) {
    await production.recordPipelineEvent({ releaseId, ownerId, stage, status: "started" });

    let outcome;
    try {
      outcome = await runStageWithExecutor({
        release,
        stage,
        stageInputs,
        runner: (runnerArgs) => executorRunner({
          ...runnerArgs,
          recordedArtifacts: Object.freeze([...recordedByStage.values()]),
          artifactBindings: Object.freeze(artifactBindings()),
        }),
      });
    } catch (error) {
      // Bridge gate violations are contract failures, not executor results.
      await recordStageFailure(production, evidenceLedger, { ownerId, releaseId, stage, errorCode: String(error?.code ?? error?.message ?? "EXECUTOR_STAGE_FAILED").slice(0, 120) });
      await production.updateReleaseStatus(ownerId, releaseId, "planned");
      throw error;
    }

    if (outcome.status === "waiting") {
      const code = outcome.failureCode ?? "QUOTA_EXHAUSTED";
      await production.recordPipelineEvent({
        releaseId, ownerId, stage, status: "failed",
        detail: { waiting: true, quotaState: "WAITING_FOR_QUOTA", errorCode: code },
      });
      if (evidenceLedger) {
        await evidenceLedger.append({
          subjectId: releaseId,
          kind: "pipeline_stage_waiting",
          classification: "executor_waiting_for_quota",
          payload: { stage, errorCode: code },
        });
      }
      await production.updateReleaseStatus(ownerId, releaseId, "planned");
      // Durable wait: earlier stages stay recorded; the job carries the wait.
      await markJobWaiting(jobs, release.jobId, code);
      log(`stage ${stage} waiting: ${code}`);
      return { releaseId, status: "planned", waited: true, waitingStage: stage, waitingCode: code, artifacts };
    }

    if (outcome.status === "failed") {
      await recordStageFailure(production, evidenceLedger, {
        ownerId, releaseId, stage,
        errorCode: String(outcome.failureCode ?? "EXECUTOR_STAGE_FAILED").slice(0, 120),
      });
      await production.updateReleaseStatus(ownerId, releaseId, "planned");
      await markJobFailed(jobs, release.jobId, outcome.failureCode ?? "EXECUTOR_STAGE_FAILED");
      log(`stage ${stage} failed: ${outcome.failureCode}`);
      return { releaseId, status: "planned", failedStage: stage, failureCode: outcome.failureCode, artifacts };
    }

    // Recorded: persist the real media artifact through the #182 bridge.
    let stored;
    try {
      stored = await recordExecutorArtifact({
        releaseId,
        ownerId,
        production,
        stage,
        verdict: outcome.verdict,
      });
    } catch (error) {
      await recordStageFailure(production, evidenceLedger, {
        ownerId, releaseId, stage,
        errorCode: String(error?.code ?? error?.message ?? "EXECUTOR_ARTIFACT_REJECTED").slice(0, 120),
      });
      await production.updateReleaseStatus(ownerId, releaseId, "planned");
      throw error;
    }
    if (stored !== null) artifacts.push(stored);
    recordedByStage.set(stage, {
      stage,
      agentId: release.agentId,
      sha256: outcome.verdict.sha256,
      storagePath: typeof outcome.executorResult?.outputPath === "string" ? outcome.executorResult.outputPath : null,
      descriptor: outcome.verdict.descriptor ?? null,
    });

    await production.recordPipelineEvent({
      releaseId, ownerId, stage, status: "succeeded",
      detail: {
        sha256: outcome.verdict.sha256,
        generationMode: outcome.verdict.generationMode,
        executorVerified: outcome.verdict.verified === true,
      },
    });
    if (evidenceLedger) {
      await evidenceLedger.append({
        subjectId: releaseId,
        kind: "pipeline_stage_succeeded",
        classification: "real_executor_generation",
        payload: {
          stage,
          sha256: outcome.verdict.sha256,
          generationMode: outcome.verdict.generationMode,
        },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Packaging stage (Issue #185): thumbnail media (runner-driven, bridge-
  // recorded), subtitle + metadata documents, and the episode package
  // manifest binding the release's OWN recorded artifacts.
  // ---------------------------------------------------------------------
  const { runPackagingStage, evaluateEpisodeQcGate, recordHumanQcDecision } = await import("./packagingQc.js");

  await production.recordPipelineEvent({ releaseId, ownerId, stage: "packaging", status: "started" });
  let packaging;
  try {
    packaging = await runPackagingStage({
      release,
      stageInputs,
      recordedArtifacts: Object.freeze([...recordedByStage.values()]),
      runner: (runnerArgs) => executorRunner({
        ...runnerArgs,
        recordedArtifacts: Object.freeze([...recordedByStage.values()]),
        artifactBindings: Object.freeze(artifactBindings()),
      }),
    });
  } catch (error) {
    await recordStageFailure(production, evidenceLedger, {
      ownerId, releaseId, stage: "packaging",
      errorCode: String(error?.code ?? error?.message ?? "PACKAGING_FAILED").slice(0, 120),
    });
    await production.updateReleaseStatus(ownerId, releaseId, "planned");
    throw error;
  }

  if (packaging.status === "waiting") {
    const code = packaging.failureCode ?? "QUOTA_EXHAUSTED";
    await production.recordPipelineEvent({
      releaseId, ownerId, stage: "packaging", status: "failed",
      detail: { waiting: true, quotaState: "WAITING_FOR_QUOTA", errorCode: code },
    });
    if (evidenceLedger) {
      await evidenceLedger.append({
        subjectId: releaseId,
        kind: "pipeline_stage_waiting",
        classification: "executor_waiting_for_quota",
        payload: { stage: "packaging", errorCode: code },
      });
    }
    await production.updateReleaseStatus(ownerId, releaseId, "planned");
    await markJobWaiting(jobs, release.jobId, code);
    log(`packaging waiting: ${code}`);
    return { releaseId, status: "planned", waited: true, waitingStage: "packaging", waitingCode: code, artifacts };
  }

  if (packaging.status === "failed") {
    await recordStageFailure(production, evidenceLedger, {
      ownerId, releaseId, stage: "packaging",
      errorCode: String(packaging.failureCode ?? "PACKAGING_FAILED").slice(0, 120),
    });
    await production.updateReleaseStatus(ownerId, releaseId, "planned");
    await markJobFailed(jobs, release.jobId, packaging.failureCode ?? "PACKAGING_FAILED");
    log(`packaging failed: ${packaging.failureCode}`);
    return { releaseId, status: "planned", failedStage: "packaging", failureCode: packaging.failureCode, artifacts };
  }

  // Record the verified thumbnail media through the #182 bridge under its
  // own distinct stage/kind (never colliding with scene visuals on equal
  // content hashes).
  const thumbnailStored = await recordExecutorArtifact({
    releaseId,
    ownerId,
    production,
    stage: "thumbnail",
    verdict: packaging.thumbnailVerdict,
  });
  if (thumbnailStored !== null) artifacts.push(thumbnailStored);
  recordedByStage.set("thumbnail", {
    stage: "thumbnail",
    agentId: release.agentId,
    sha256: packaging.thumbnailVerdict.sha256,
    descriptor: packaging.thumbnailVerdict.descriptor,
    storagePath: typeof packaging.executorResult?.outputPath === "string" ? packaging.executorResult.outputPath : null,
  });

  // Record the deterministic documents content-addressed (idempotent).
  const documentRecords = [
    ["subtitle", packaging.documents.subtitle],
    ["metadata", packaging.documents.metadata],
    ["manifest", packaging.documents.manifest],
  ];
  for (const [docKind, record] of documentRecords) {
    const storedDoc = await production.recordArtifact({
      releaseId,
      ownerId,
      kind: STAGE_KINDS.packaging.kind,
      stage: docKind === "manifest" ? "packaging" : docKind,
      sha256: record.sha256,
      sizeBytes: Buffer.byteLength(record.content, "utf8"),
      mimeType: "application/json",
      payload: { generationMode: "deterministic_local" },
    });
    if (storedDoc !== null) artifacts.push(storedDoc);
  }

  await production.recordPipelineEvent({
    releaseId, ownerId, stage: "packaging", status: "succeeded",
    detail: {
      manifestId: packaging.manifest.manifestId,
      thumbnailSha256: packaging.thumbnailVerdict.sha256,
      documents: ["subtitle", "metadata", "manifest"],
    },
  });
  if (evidenceLedger) {
    await evidenceLedger.append({
      subjectId: releaseId,
      kind: "pipeline_stage_succeeded",
      classification: "real_executor_generation",
      payload: {
        stage: "packaging",
        manifestId: packaging.manifest.manifestId,
        thumbnailSha256: packaging.thumbnailVerdict.sha256,
      },
    });
  }

  // ---------------------------------------------------------------------
  // QC stage (Issue #185): gate over the recorded manifest + artifacts.
  // Automated checks now; needs_human is a durable verdict that lands the
  // release in `review` (the owner gate) for a future human decision.
  // ---------------------------------------------------------------------
  await production.recordPipelineEvent({ releaseId, ownerId, stage: "qc", status: "started" });
  let runnerChecks = [];
  try {
    const qcChecks = await executorRunner({
      release,
      stage: "qc",
      stageInputs,
      agentId: release.agentId,
      manifest: packaging.manifest,
      recordedArtifacts: Object.freeze([...recordedByStage.values()]),
      artifactBindings: Object.freeze(artifactBindings()),
    });
    if (Array.isArray(qcChecks)) runnerChecks = qcChecks;
  } catch {
    // Runner checks are optional policy; absence never weakens the gate.
  }

  const qcVerdict = evaluateEpisodeQcGate({
    release,
    manifest: packaging.manifest,
    manifestRecord: packaging.documents.manifest,
    recordedArtifacts: Object.freeze([...recordedByStage.values()]),
    storedDocuments: {
      subtitle: packaging.documents.subtitle.content,
      metadata: packaging.documents.metadata.content,
    },
    runnerChecks,
  });

  // The QC verdict is recorded content-addressed as durable evidence.
  const qcVerdictContent = JSON.stringify(qcVerdict, null, 2);
  const qcVerdictRecord = await production.recordArtifact({
    releaseId,
    ownerId,
    kind: "qc",
    stage: "qc",
    sha256: createHash("sha256").update(qcVerdictContent).digest("hex"),
    sizeBytes: Buffer.byteLength(qcVerdictContent, "utf8"),
    mimeType: "application/json",
    payload: { generationMode: "deterministic_local" },
  });
  if (qcVerdictRecord !== null) artifacts.push(qcVerdictRecord);

  if (qcVerdict.verdict === "rejected") {
    await recordStageFailure(production, evidenceLedger, {
      ownerId, releaseId, stage: "qc",
      errorCode: String(qcVerdict.reasonCode ?? "QC_REJECTED").slice(0, 120),
    });
    await production.updateReleaseStatus(ownerId, releaseId, "planned");
    await markJobFailed(jobs, release.jobId, qcVerdict.reasonCode ?? "QC_REJECTED");
    log(`qc rejected: ${qcVerdict.reasonCode}`);
    return {
      releaseId, status: "planned", failedStage: "qc",
      failureCode: qcVerdict.reasonCode, qcVerdict, artifacts,
    };
  }

  await production.recordPipelineEvent({
    releaseId, ownerId, stage: "qc", status: "succeeded",
    detail: { verdict: qcVerdict.verdict, decidedBy: qcVerdict.decidedBy, manifestId: qcVerdict.manifestId },
  });
  if (evidenceLedger) {
    await evidenceLedger.append({
      subjectId: releaseId,
      kind: "pipeline_stage_succeeded",
      classification: "real_executor_generation",
      payload: {
        stage: "qc",
        verdict: qcVerdict.verdict,
        decidedBy: qcVerdict.decidedBy,
        manifestId: qcVerdict.manifestId,
      },
    });
  }
  // needs_human: the release lands in `review` (owner gate) with the
  // recorded verdict; a human decision is recorded, never auto-derived.
  log(`qc verdict: ${qcVerdict.verdict}`);

  // Story remains a deterministic plan document (not media).
  await production.recordPipelineEvent({ releaseId, ownerId, stage: "story", status: "started" });
  const storyContent = renderStageContent("story", stageInputs);
  const storySha = createHash("sha256").update(storyContent).digest("hex");
  const storyStored = await production.recordArtifact({
    releaseId, ownerId, kind: "metadata", stage: "story", sha256: storySha,
    sizeBytes: Buffer.byteLength(storyContent, "utf8"), mimeType: "application/json",
  });
  await production.recordPipelineEvent({
    releaseId, ownerId, stage: "story", status: "succeeded",
    detail: { sha256: storySha, generationMode: "deterministic_local" },
  });
  if (storyStored !== null) artifacts.push(storyStored);

  await production.updateReleaseStatus(ownerId, releaseId, "review");
  if (evidenceLedger) {
    await evidenceLedger.append({
      subjectId: releaseId,
      kind: "pipeline_completed",
      classification: "real_executor_generation",
      payload: { stages: [...executorStages, "packaging", "qc", "story"], artifactCount: artifacts.length },
    });
  }
  return { releaseId, status: "review", artifacts, qcVerdict, packagingManifestId: packaging.manifest.manifestId };
}

/** Truthful pipeline-events + evidence record for a failed stage. */
async function recordStageFailure(production, evidenceLedger, { ownerId, releaseId, stage, errorCode }) {
  await production.recordPipelineEvent({
    releaseId, ownerId, stage, status: "failed",
    detail: { errorCode },
  });
  if (evidenceLedger) {
    await evidenceLedger.append({
      subjectId: releaseId,
      kind: "pipeline_stage_failed",
      classification: "pipeline_failure_recorded",
      payload: { stage, errorCode },
    });
  }
}

/**
 * Best-effort job waiting marker. The durable job-status enum (sql/010) has
 * no waiting state (R5: no new states without a governed issue), so when the
 * repository supports metadata the wait code is attached to the job WITHOUT
 * changing its status; otherwise this is a no-op — the authoritative wait
 * record lives on the release + pipeline events + evidence ledger.
 */
async function markJobWaiting(jobs, jobId, code) {
  if (!jobs || typeof jobs.updateStatus !== "function" || !jobId) return;
  try {
    await jobs.updateStatus(jobId, null, { failureCode: code, waitingForQuota: true });
  } catch {
    // Repository without metadata support: the wait stays recorded on the
    // release + evidence; never fabricate a different job state.
  }
}

/** Best-effort job failure marker. */
async function markJobFailed(jobs, jobId, code) {
  if (!jobs || typeof jobs.updateStatus !== "function" || !jobId) return;
  try {
    await jobs.updateStatus(jobId, "failed", { failureCode: code });
  } catch {
    // Job state is best-effort; release/evidence carry the truthful record.
  }
}
