/**
 * These contracts are the only supported boundary for third-party components.
 * Implementations run as isolated workers and receive job-scoped inputs.
 */
export const WORKER_CAPABILITIES = Object.freeze({
  JARVIS_STORY: "story.universe_and_continuity",
  VIMAX_MOTION: "video.ai_motion",
  MONEY_PRINTER_ASSEMBLY: "video.stock_assembly",
  MONEY_PRINTER_TURBO_SHORTS: "video.vertical_short_assembly",
  POSTIZ_PUBLISHING: "social.owner_approved_publish"
});

export function validateWorkerResult(result) {
  if (!result?.jobId || !result?.capability || !result?.status) {
    throw new Error("INVALID_WORKER_RESULT");
  }
  if (result.status === "succeeded" &&
      (!result.artifact?.uri ||
       !/^[a-f0-9]{64}$/i.test(result.artifact?.sha256 ?? "") ||
       !result.evidence?.receiptId)) {
    throw new Error("SUCCESS_REQUIRES_ARTIFACT_AND_EVIDENCE");
  }
  return Object.freeze({
    ...result,
    artifact: result.artifact && Object.freeze({ ...result.artifact }),
    evidence: result.evidence && Object.freeze({ ...result.evidence })
  });
}
