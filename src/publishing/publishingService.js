import { createHash, randomUUID } from "node:crypto";

function getAttributionHash(validatedAttribution) {
  if (!validatedAttribution) return "";
  const stable = {
    sourceAgentId: validatedAttribution.sourceAgentId,
    publicAttribution: validatedAttribution.publicAttribution,
    sourceType: validatedAttribution.sourceType,
    sourceId: validatedAttribution.sourceId,
    isValid: validatedAttribution.isValid
  };
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
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

    const agentId = input?.agentId;
    const valAtt = input?.validatedAttribution;

    if (!agentId || !valAtt || valAtt.isValid !== true) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (valAtt.sourceAgentId !== agentId) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (!valAtt.publicAttribution || !valAtt.publicAttribution.trim()) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (!["public_profile", "social_account"].includes(valAtt.sourceType)) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (!valAtt.sourceId) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }

    const attributionHash = getAttributionHash(valAtt);

    const request = Object.freeze({
      id: randomUUID(),
      agentId,
      artifactSha256: input.artifactSha256,
      destination: input.destination,
      captionSnapshot: input.captionSnapshot,
      affiliateLinkIds: Object.freeze([...(input.affiliateLinkIds ?? [])]),
      mode: input.mode ?? "draft",
      status: "awaiting_owner_approval",
      attributionSnapshot: Object.freeze({ ...valAtt }),
      attributionHash
    });
    this.#requests.set(request.id, request);
    return request;
  }

  mutateRequestForTesting(requestId, mutatedFields) {
    const request = this.#requests.get(requestId);
    if (request) {
      // Create a mutable copy of attributionSnapshot if passed
      let newAtt = request.attributionSnapshot;
      if (mutatedFields.attributionSnapshot) {
        newAtt = { ...request.attributionSnapshot, ...mutatedFields.attributionSnapshot };
      }
      this.#requests.set(requestId, Object.freeze({
        ...request,
        ...mutatedFields,
        attributionSnapshot: newAtt ? Object.freeze(newAtt) : null
      }));
    }
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

    // Recompute and verify the attribution snapshot hash before publishing
    const recomputedHash = getAttributionHash(request.attributionSnapshot);
    if (recomputedHash !== request.attributionHash) {
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
