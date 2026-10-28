import { createHash, randomUUID } from "node:crypto";
import { PublishingService, verifyAttributionSnapshot } from "./publishingService.js";

const AGENT_NAME_PATTERN = /\b(?:JARVIS|SHERLOCK|LAKME|VEDA|PANCHI|NEWTON)\b/i;
const ALLOWED_PLATFORMS = new Set(["youtube", "instagram", "facebook", "snapchat"]);

export class PrivatePublishingTestError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PrivatePublishingTestError";
    this.code = code;
    this.details = details;
  }
}

export class PrivatePublishingTestService {
  #publishingService;
  #evidenceLedger;

  constructor({ publishingService = new PublishingService(), evidenceLedger = null } = {}) {
    this.#publishingService = publishingService;
    this.#evidenceLedger = evidenceLedger;
  }

  async runPrivatePublishingTest({
    ownerId,
    agentId,
    agent,
    profile,
    primarySocialAccount,
    artifactSha256,
    destination,
    captionSnapshot,
    affiliateLinkIds = [],
    mode = "private",
    approvalExpiresInMs = 300000, // 5 minutes default
    publisher
  }) {
    if (!ownerId || typeof ownerId !== "string") {
      throw new PrivatePublishingTestError("Owner ID is required", "OWNER_ID_REQUIRED");
    }

    if (mode !== "private" && mode !== "draft") {
      throw new PrivatePublishingTestError(
        "Private-first test strictly requires 'private' or 'draft' mode",
        "PRIVATE_FIRST_MODE_REQUIRED"
      );
    }

    if (!ALLOWED_PLATFORMS.has(destination?.toLowerCase())) {
      throw new PrivatePublishingTestError(
        `Unsupported or invalid platform destination: ${destination}`,
        "INVALID_PLATFORM_DESTINATION"
      );
    }

    if (!artifactSha256 || !/^[a-f0-9]{64}$/i.test(artifactSha256)) {
      throw new PrivatePublishingTestError(
        "Verified 64-character SHA-256 artifact hash is required",
        "VERIFIED_ARTIFACT_REQUIRED"
      );
    }

    // Rule 15: Check for internal agent name leakage in caption or destination
    if (AGENT_NAME_PATTERN.test(JSON.stringify({ captionSnapshot, destination }))) {
      throw new PrivatePublishingTestError(
        "Internal agent identifier leaked in public metadata",
        "AGENT_NAME_LEAKAGE_DENIED"
      );
    }

    if (typeof publisher?.publish !== "function") {
      throw new PrivatePublishingTestError("Publisher implementation required", "PUBLISHER_REQUIRED");
    }

    // Step 1: Request publishing
    const request = this.#publishingService.request({
      agentId,
      agent,
      profile,
      primarySocialAccount,
      artifactSha256,
      destination,
      captionSnapshot,
      affiliateLinkIds,
      mode
    });

    // Step 2: Owner approves with explicit expiration
    const approvalExpiresAt = new Date(Date.now() + approvalExpiresInMs).toISOString();
    const approvedRequest = this.#publishingService.approve(request.id, {
      ownerId,
      expiresAt: approvalExpiresAt,
      approvedArtifactSha256: artifactSha256,
      mode
    });

    // Step 3: Dispatch publishing test through publisher
    const dispatchResult = await this.#publishingService.dispatch(approvedRequest.id, publisher, { dryRun: false });

    // Step 4: Validate genuine platform receipt (Rule 1 & Rule 2)
    if (!dispatchResult?.platformPostId || !dispatchResult?.platformUrl || !dispatchResult?.providerResponseSha256) {
      throw new PrivatePublishingTestError(
        "Genuine platform receipt is required for private publishing test",
        "PLATFORM_RECEIPT_REQUIRED"
      );
    }

    // Step 5: Append to Evidence Ledger if present
    if (this.#evidenceLedger) {
      this.#evidenceLedger.append({
        subjectId: approvedRequest.id,
        kind: "platform_publish",
        classification: "private_first",
        payload: {
          ownerId,
          agentId,
          artifactSha256,
          destination,
          mode,
          platformPostId: dispatchResult.platformPostId,
          platformUrl: dispatchResult.platformUrl,
          providerResponseSha256: dispatchResult.providerResponseSha256
        }
      });
    }

    return Object.freeze({
      testId: randomUUID(),
      requestId: approvedRequest.id,
      ownerId,
      agentId,
      destination,
      mode,
      status: "platform_verified",
      published: true,
      platformPostId: dispatchResult.platformPostId,
      platformUrl: dispatchResult.platformUrl,
      providerResponseSha256: dispatchResult.providerResponseSha256,
      publicAttribution: approvedRequest.attributionSnapshot.publicAttribution
    });
  }
}
