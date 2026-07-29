import { createHash, randomUUID } from "node:crypto";
import { resolvePublicAttribution } from "../catalog/agentDigitalIdentity.js";

export function verifyAttributionSnapshot(snapshot, expectedHash) {
  if (!snapshot) return false;
  const stable = {
    sourceAgentId: snapshot.sourceAgentId,
    publicAttribution: snapshot.publicAttribution,
    sourceType: snapshot.sourceType,
    sourceId: snapshot.sourceId,
    isValid: snapshot.isValid
  };
  const computed = createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
  return computed === expectedHash;
}

export class PublishingService {
  #requests = new Map();

  request(input) {
    if (!/^[a-f0-9]{64}$/i.test(input?.artifactSha256 ?? "")) {
      throw new Error("VERIFIED_ARTIFACT_REQUIRED");
    }
    if (!input.destination || !input.captionSnapshot) {
      throw new Error("PUBLISHING_SNAPSHOT_REQUIRED");
    }

    const { agentId, agent, profile, primarySocialAccount } = input;

    // Call resolvePublicAttribution internally. We do not trust any pre-packaged object.
    const validatedAttribution = resolvePublicAttribution({
      agentId,
      agent,
      profile,
      primarySocialAccount
    });

    const attributionHash = createHash("sha256")
      .update(JSON.stringify({
        sourceAgentId: validatedAttribution.sourceAgentId,
        publicAttribution: validatedAttribution.publicAttribution,
        sourceType: validatedAttribution.sourceType,
        sourceId: validatedAttribution.sourceId,
        isValid: validatedAttribution.isValid
      }))
      .digest("hex");

    const request = Object.freeze({
      id: randomUUID(),
      agentId,
      artifactSha256: input.artifactSha256,
      destination: input.destination,
      captionSnapshot: input.captionSnapshot,
      affiliateLinkIds: Object.freeze([...(input.affiliateLinkIds ?? [])]),
      mode: input.mode ?? "draft",
      status: "awaiting_owner_approval",
      attributionSnapshot: Object.freeze({ ...validatedAttribution }),
      attributionHash
    });
    this.#requests.set(request.id, request);
    return request;
  }

  approve(requestId, approval) {
    const request = this.#requests.get(requestId);
    if (!request) throw new Error("PUBLISHING_REQUEST_NOT_FOUND");
    if (!approval?.ownerId || !approval?.expiresAt) {
      throw new Error("OWNER_APPROVAL_REQUIRED");
    }
    if (new Date(approval.expiresAt) <= new Date()) {
      throw new Error("APPROVAL_EXPIRED");
    }
    const approved = Object.freeze({
      ...request,
      status: "approved",
      approval: Object.freeze({ ...approval })
    });
    this.#requests.set(requestId, approved);
    return approved;
  }

  async dispatch(requestId, publisher, { dryRun = true } = {}) {
    const request = this.#requests.get(requestId);
    if (!request || request.status !== "approved") {
      throw new Error("ACTIVE_OWNER_APPROVAL_REQUIRED");
    }
    if (new Date(request.approval.expiresAt) <= new Date()) {
      throw new Error("APPROVAL_EXPIRED");
    }

    // Verify snapshot integrity
    if (!verifyAttributionSnapshot(request.attributionSnapshot, request.attributionHash)) {
      throw new Error("ATTRIBUTION_SNAPSHOT_HASH_MISMATCH");
    }

    if (dryRun) {
      return Object.freeze({
        requestId,
        status: "dry_run_completed",
        published: false
      });
    }

    const response = await publisher.publish(request);
    if (!response?.platformPostId || !response?.platformUrl || !response?.rawResponse) {
      throw new Error("PLATFORM_RECEIPT_REQUIRED");
    }
    return Object.freeze({
      requestId,
      status: "platform_verified",
      published: true,
      platformPostId: response.platformPostId,
      platformUrl: response.platformUrl,
      providerResponseSha256: createHash("sha256")
        .update(response.rawResponse)
        .digest("hex")
    });
  }
}
