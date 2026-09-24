/**
 * ST Production House — Hermes → durable job pipeline bridge.
 *
 * Issue #168. Executes Hermes manager decisions against the REAL production
 * pipeline. A `production.start` decision in state EXECUTING queues an
 * actual episode through the SAME transactional path as the owner API
 * (`ProductionRepository.createReleaseWithJob`): one release + one queued
 * `episode_production` job, database-enforced unique per (channel, season,
 * episode) — a failed attempt creates a new attempt, never a second logical
 * release (Rule 8).
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 15, 17):
 *   - NO BYPASS: the bridge only QUEUES work. Publishing remains
 *     owner-policy controlled (Rule 7/9); this module never publishes.
 *   - Tenant isolation: the decision's directorId MUST equal the target
 *     channel's agentId. Queueing work for a different director fails
 *     closed (DIRECTOR_CHANNEL_MISMATCH) — Hermes cannot move one
 *     director's identity onto another's channel (Rule 5).
 *   - Owner identity is SERVER-authoritative: callers pass the ownerId from
 *     the authenticated session, never from the decision payload.
 *   - Honest outcomes (Rule 1): the queueing attempt appends an evidence
 *     event (`production_queued`, subjectId = releaseId). The decision may
 *     be completed EXECUTED only after the ledger verifies that receipt.
 *     Conflicts and validation failures are recorded as FAILED with stable
 *     error codes — never silently swallowed, never faked.
 *   - No secrets, no network I/O, no new status states (R5): the job row
 *     uses the existing lifecycle enum ('queued').
 *
 * Payload contract (identical bounds to POST /api/productions):
 *   { channelId, title, season (1..100), episode (1..2000) }
 */

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate a production.start payload. Same bounds as the owner API route.
 * Throws stable error codes; the caller maps them to 4xx honestly.
 */
export function validateProductionStartPayload(payload) {
  if (!isPlainObject(payload)) throw fail("PRODUCTION_PAYLOAD_INVALID");
  const allowed = ["channelId", "title", "season", "episode"];
  if (!Object.keys(payload).every((key) => allowed.includes(key))) {
    throw fail("PRODUCTION_PAYLOAD_INVALID");
  }
  const { channelId, title, season, episode } = payload;
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 80) {
    throw fail("PRODUCTION_PAYLOAD_INVALID");
  }
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 200) {
    throw fail("PRODUCTION_VALIDATION_FAILED");
  }
  const seasonNum = Number(season);
  const episodeNum = Number(episode);
  if (!Number.isSafeInteger(seasonNum) || seasonNum < 1 || seasonNum > 100 ||
      !Number.isSafeInteger(episodeNum) || episodeNum < 1 || episodeNum > 2000) {
    throw fail("PRODUCTION_VALIDATION_FAILED");
  }
  return { channelId, title: title.trim(), season: seasonNum, episode: episodeNum };
}

/**
 * Create the bridge over injected dependencies.
 *
 *   production  ProductionRepository (getChannel, createReleaseWithJob)
 *   evidence    evidence ledger ({ append } or EvidenceLedgerRepository)
 *   audit       optional async (ownerId, event, detail) audit sink
 */
export function createHermesJobBridge({ production, evidence, audit } = {}) {
  if (!production || typeof production.createReleaseWithJob !== "function" ||
      typeof production.getChannel !== "function") {
    throw fail("HERMES_BRIDGE_PRODUCTION_REPO_REQUIRED");
  }
  if (!evidence || typeof evidence.append !== "function") {
    throw fail("HERMES_BRIDGE_EVIDENCE_REQUIRED");
  }

  /**
   * Execute one decision. ONLY `production.start` is executable here; every
   * other action is refused (EXECUTION_ACTION_NOT_EXECUTABLE) — the bridge
   * grows one action at a time through governed slices.
   *
   * Flow: decision lookup → state guard (EXECUTING only) → action guard →
   * payload validation → channel resolution (404-safe) → tenant-isolation
   * guard → transactional queueing → evidence event.
   *
   * Returns { status: "QUEUED", decision, release, jobId, receiptId } on
   * success. On failure it records the honest completion via
   * `completeDecision` and returns { status: "FAILED", decision, errorCode }.
   */
  return async function executeHermesDecision(manager, ownerId, decisionNumber) {
    if (!manager || typeof manager.getDecision !== "function" || typeof manager.completeDecision !== "function") {
      throw fail("HERMES_BRIDGE_MANAGER_REQUIRED");
    }
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw fail("HERMES_BRIDGE_OWNER_REQUIRED");
    }
    const decision = await manager.getDecision(decisionNumber);
    if (!decision) throw fail("DECISION_NOT_FOUND");

    const recordFailure = async (errorCode) => {
      const completed = await manager.completeDecision(decisionNumber, {
        succeeded: false,
        errorCode,
        detail: `Execution refused: ${errorCode}`,
      });
      return { status: "FAILED", decision: completed, errorCode };
    };

    if (decision.outcome !== "EXECUTING") {
      // BLOCKED / FAILED / EXECUTED are terminal states that already carry
      // their honest outcome — the bridge refuses WITHOUT re-recording
      // (a BLOCKED refusal must not be rewritten as a FAILED execution).
      return { status: "REFUSED", decision, errorCode: "DECISION_NOT_EXECUTING" };
    }
    if (decision.action !== "production.start") {
      return recordFailure("EXECUTION_ACTION_NOT_EXECUTABLE");
    }

    let request;
    try {
      request = validateProductionStartPayload(decision.payload);
    } catch (err) {
      return recordFailure(err.code ?? "PRODUCTION_PAYLOAD_INVALID");
    }

    const channel = await production.getChannel(ownerId, request.channelId);
    if (!channel) {
      return recordFailure("CHANNEL_NOT_FOUND");
    }
    if (channel.agentEnabled === false) {
      return recordFailure("AGENT_DISABLED");
    }
    // Tenant isolation (Rule 5): the decision's director must OWN the
    // channel it is queueing work for.
    if (decision.directorId !== channel.agentId) {
      return recordFailure("DIRECTOR_CHANNEL_MISMATCH");
    }

    let queued;
    try {
      queued = await production.createReleaseWithJob(ownerId, {
        channelId: request.channelId,
        agentId: channel.agentId,
        title: request.title,
        season: request.season,
        episode: request.episode,
      });
    } catch (err) {
      return recordFailure("PRODUCTION_QUEUE_FAILED");
    }
    if (queued.conflict) {
      return recordFailure("PRODUCTION_ALREADY_EXISTS");
    }

    // Honest evidence (Rule 1): the receipt the ledger can verify.
    const stored = await evidence.append({
      subjectId: queued.release.id,
      kind: "production_queued",
      classification: "hermes_manager_decision",
      payload: {
        decisionNumber: decision.decisionNumber,
        directorId: decision.directorId,
        channelId: request.channelId,
        season: request.season,
        episode: request.episode,
        jobId: queued.jobId,
      },
    });
    const receiptId = stored?.id ?? null;

    if (typeof audit === "function") {
      await audit(ownerId, "hermes_decision_executed", {
        decisionNumber: decision.decisionNumber,
        releaseId: queued.release.id,
        jobId: queued.jobId,
        channelId: request.channelId,
      }).catch(() => {});
    }

    return {
      status: "QUEUED",
      decision,
      release: queued.release,
      jobId: queued.jobId,
      receiptId,
    };
  };
}
