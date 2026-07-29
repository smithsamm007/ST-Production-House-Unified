import { createHash, randomUUID } from "node:crypto";
import { isInternalAgentName } from "../catalog/agentDigitalIdentity.js";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

export class PublishingService {
  #requests = new Map();

  request(input) {
    if (!/^[a-f0-9]{64}$/i.test(input?.artifactSha256 ?? "")) {
      throw new Error("VERIFIED_ARTIFACT_REQUIRED");
    }
    if (!input.destination || !input.captionSnapshot) {
      throw new Error("PUBLISHING_SNAPSHOT_REQUIRED");
    }
    const attribution = input?.publicAttribution;
    if (typeof attribution !== "string" || !attribution.trim() || attribution === "PUBLIC_PUBLISHING_IDENTITY_REQUIRED") {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }

    // Dynamic internal agent name check dynamically using the preloaded agents,
    // plus any dynamically supplied agent object (for agents 21-50)
    const matchesAnyPreloaded = PRELOADED_AGENTS.some((a) => isInternalAgentName(attribution, a));
    const matchesSelectedAgent = input.agent ? isInternalAgentName(attribution, input.agent) : false;

    if (matchesAnyPreloaded || matchesSelectedAgent) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }

    const request = Object.freeze({
      id: randomUUID(),
      artifactSha256: input.artifactSha256,
      destination: input.destination,
      captionSnapshot: input.captionSnapshot,
      affiliateLinkIds: Object.freeze([...(input.affiliateLinkIds ?? [])]),
      mode: input.mode ?? "draft",
      status: "awaiting_owner_approval",
      publicAttribution: attribution
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
    if (dryRun) {
      return Object.freeze({
        requestId,
        status: "dry_run_completed",
        published: false
      });
    }
    const attribution = request.publicAttribution;
    if (typeof attribution !== "string" || !attribution.trim() || attribution === "PUBLIC_PUBLISHING_IDENTITY_REQUIRED") {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }

    const matchesAnyPreloaded = PRELOADED_AGENTS.some((a) => isInternalAgentName(attribution, a));
    if (matchesAnyPreloaded) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
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
