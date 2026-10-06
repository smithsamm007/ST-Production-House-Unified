/**
 * ST Production House — YouTube publish execution for the owner route
 * (Issue #217: wire src/publishing/youtubePublisher.js into the owner
 * publishing boundary).
 *
 * This is the seam between `POST /api/productions/:id/publish`
 * (src/catalog/server.js) and the existing YouTube upload adapter. It
 * performs, in order, the checks the Master Completion Prompt §7 requires:
 *
 *   1. Director binding      — release → channel → agentId (owner-scoped).
 *   2. Main artifact         — `stage=assembly`, `kind=video` (the canonical
 *                              main video; reels are a different stage).
 *   3. FFprobe gate          — `ffprobeVerified === true` or fail 409; an
 *                              unverified artifact NEVER reaches the network.
 *   4. Durable media path    — the real executor output path persisted with
 *                              the artifact (metadata.storagePath); missing →
 *                              honest 409, never a fabricated upload.
 *   5. Owner approval        — a durable `publishing_requests` row approved
 *                              by the authenticated owner and bound to the
 *                              EXACT artifact hash + destination (Rule 7).
 *   6. Private-first          — visibility is forced `private` here; the route
 *                              never accepts a client-supplied visibility and
 *                              the adapter refuses `public` anyway.
 *   7. Token                  — resolved per (ownerId, agentId) through
 *                              YouTubeOAuthService.getPublishingAccessToken,
 *                              which reads ONLY the secret-manager boundary
 *                              (Rule 17; the token never serializes).
 *   8. Receipt                — persisted to `publishing_receipts` from the
 *                              REAL adapter receipt only (Rule 2 — no
 *                              fabricated platform IDs), then evidence
 *                              `platform_publish` (the ledger requires the
 *                              three receipt fields) is appended.
 *
 * Durable idempotency: if a receipt already exists for this artifact +
 * destination, the stored receipt is replayed with `duplicate: true` and NO
 * network call — a retry can never double-publish (Rule: never double-publish).
 *
 * All failures throw `Error` objects carrying a stable `.code`; the route maps
 * them to honest HTTP statuses. Nothing here converts a failure into success.
 */

import { createHash } from "node:crypto";
import { createYouTubePublisher } from "./youtubePublisher.js";

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_CAPTION_BYTES = 4096;
const MAX_TITLE_LENGTH = 100;

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Choose the main upload artifact for a release.
 *
 * Returns the NEWEST ffprobe-verified `assembly`-stage video artifact
 * (artifacts are listed in creation order, so the last match is the newest
 * assembly). Stable fail-closed codes — an unverified or missing artifact
 * never proceeds to approval or the network.
 */
export function selectMainUploadArtifact(artifacts) {
  if (!Array.isArray(artifacts)) throw fail("ASSEMBLY_ARTIFACT_MISSING");
  const assemblyVideos = artifacts.filter(
    (artifact) => artifact?.kind === "video" && artifact?.stage === "assembly",
  );
  if (assemblyVideos.length === 0) throw fail("ASSEMBLY_ARTIFACT_MISSING");
  const verified = assemblyVideos.filter((artifact) => artifact?.ffprobeVerified === true);
  if (verified.length === 0) throw fail("ARTIFACT_NOT_FFPROBE_VERIFIED");
  return verified[verified.length - 1];
}

/** Resolve (or default) the caption/metadata snapshot; bounded and explicit. */
function resolveCaptionSnapshot(captionSnapshot, release) {
  const caption =
    captionSnapshot === undefined || captionSnapshot === null
      ? { title: typeof release?.title === "string" ? release.title : "" }
      : captionSnapshot;
  if (!isPlainObject(caption)) throw fail("PUBLISHING_SNAPSHOT_INVALID");
  const { title, description, tags } = caption;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw fail("PUBLISHING_SNAPSHOT_INVALID");
  }
  if (description !== undefined && typeof description !== "string") {
    throw fail("PUBLISHING_SNAPSHOT_INVALID");
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw fail("PUBLISHING_SNAPSHOT_INVALID");
  }
  if (Buffer.byteLength(JSON.stringify(caption), "utf8") > MAX_CAPTION_BYTES) {
    throw fail("PUBLISHING_SNAPSHOT_INVALID");
  }
  return caption;
}

/**
 * Execute (or honestly replay) one private-first YouTube upload for the owner
 * publishing route.
 *
 * Required collaborators (all server-side; never accepted from the request):
 *   publishingRepo  — durable publishing_requests / publishing_receipts
 *   evidenceLedger  — append-only ledger (or null to skip, honestly)
 *   oauthService    — YouTubeOAuthService (getPublishingAccessToken)
 *   publishTransport— optional injected transport (tests); default = adapter's
 */
export async function executeYouTubePublish({
  ownerId,
  release,
  destination,
  artifacts,
  captionSnapshot = undefined,
  publishingRepo,
  evidenceLedger = null,
  oauthService,
  publishTransport = null,
  now = () => new Date(),
}) {
  if (!ownerId || !release?.id) throw fail("REQUEST_VALIDATION_FAILED");
  if (!publishingRepo || typeof publishingRepo.createRequest !== "function") {
    throw fail("PUBLISHING_REPOSITORY_UNAVAILABLE");
  }
  if (!oauthService || typeof oauthService.getPublishingAccessToken !== "function") {
    throw fail("OAUTH_SERVICE_UNAVAILABLE");
  }
  if (destination?.platform !== "youtube") throw fail("YOUTUBE_DESTINATION_REQUIRED");
  // Director binding: release → channel → agent resolved by getRelease.
  if (!release.agentId) throw fail("DIRECTOR_BINDING_MISSING");

  const caption = resolveCaptionSnapshot(captionSnapshot, release);
  const artifact = selectMainUploadArtifact(artifacts);
  if (!artifact.mediaPath) throw fail("ARTIFACT_MEDIA_UNAVAILABLE");

  // ---- Durable idempotency: a real receipt for this artifact already
  // exists → replay it. Zero network calls; never double-publish.
  const priorRequest = await publishingRepo.findLatestRequestByArtifact(artifact.id, "youtube");
  if (priorRequest) {
    const priorReceipt = await publishingRepo.findReceiptByRequestId(priorRequest.id);
    if (priorReceipt) {
      return Object.freeze({
        publishingRequestId: priorRequest.id,
        receiptId: priorReceipt.id,
        platformPostId: priorReceipt.platform_post_id,
        platformUrl: priorReceipt.platform_url,
        providerResponseSha256: priorReceipt.provider_response_sha256,
        visibility: "private",
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        duplicate: true,
      });
    }
    // A prior request WITHOUT a receipt means a previous attempt never
    // completed: fall through and create a fresh, freshly-approved request.
  }

  // ---- Durable owner approval bound to the EXACT artifact (Rule 7).
  const requestRow = await publishingRepo.createRequest({
    artifactId: artifact.id,
    destination: "youtube",
    captionSnapshot: JSON.stringify(caption),
    mode: "private",
    status: "pending",
  });
  if (!requestRow?.id) throw fail("PUBLISHING_REQUEST_UNAVAILABLE");
  const expiresAt = new Date(now().getTime() + APPROVAL_TTL_MS).toISOString();
  await publishingRepo.approveRequest(requestRow.id, ownerId, expiresAt);

  // ---- Real upload through the existing adapter (private visibility forced).
  const publisher = createYouTubePublisher({
    resolveAccessToken: ({ ownerId: tokenOwner, agentId: tokenAgent }) =>
      oauthService.getPublishingAccessToken({ ownerId: tokenOwner, agentId: tokenAgent }),
    ...(publishTransport ? { transport: publishTransport } : {}),
    now,
  });
  const receipt = await publisher.publish({
    ownerId,
    agentId: release.agentId,
    artifactSha256: artifact.sha256,
    destination: "youtube",
    captionSnapshot: caption,
    visibility: "private",
    approval: {
      ownerId,
      expiresAt,
      artifactSha256: artifact.sha256,
      destination: "youtube",
    },
    mediaFilePath: artifact.mediaPath,
  });

  const providerResponseSha256 = createHash("sha256")
    .update(receipt.rawResponse)
    .digest("hex");
  const receiptRow = await publishingRepo.createReceipt({
    publishingRequestId: requestRow.id,
    platformPostId: receipt.platformPostId,
    platformUrl: receipt.platformUrl,
    providerResponseSha256,
  });
  if (!receiptRow?.id) throw fail("PUBLISHING_RECEIPT_UNAVAILABLE");

  // ---- Evidence: the ledger REQUIRES the three real receipt fields for
  // platform_publish (no receipt → no evidence → no success claim).
  if (evidenceLedger && typeof evidenceLedger.append === "function") {
    await evidenceLedger.append({
      subjectId: release.id,
      kind: "platform_publish",
      classification: "private_first",
      payload: {
        ownerId,
        agentId: release.agentId,
        destination: "youtube",
        mode: "private",
        artifactSha256: artifact.sha256,
        platformPostId: receipt.platformPostId,
        platformUrl: receipt.platformUrl,
        providerResponseSha256,
      },
    });
  }

  return Object.freeze({
    publishingRequestId: requestRow.id,
    receiptId: receiptRow.id,
    platformPostId: receipt.platformPostId,
    platformUrl: receipt.platformUrl,
    providerResponseSha256,
    visibility: "private",
    artifactId: artifact.id,
    artifactSha256: artifact.sha256,
    duplicate: false,
  });
}
