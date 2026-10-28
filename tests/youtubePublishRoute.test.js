/**
 * YouTube publisher route wiring — owner publishing boundary (Issue #217).
 *
 * Boots the labeled demo-backed app and drives
 * `POST /api/productions/:id/publish` through the REAL wired path:
 *
 *   owner session auth + CSRF → Rule 7 publish gate → Director binding
 *   → FFprobe-verified assembly artifact (+ durable executor media path)
 *   → durable publishing_requests approval bound to the exact artifact
 *   → Director-scoped OAuth token resolved ONLY through the secret-manager
 *   → src/publishing/youtubePublisher.js resumable upload (private-first)
 *   → durable publishing_receipts row + `platform_publish` evidence + audit.
 *
 * OFFLINE BY CONSTRUCTION: the Google OAuth transport, the secret manager,
 * and the publish transport are all INJECTED and scripted. No network call
 * is made, no live Google account exists, and no live upload happens here.
 * Passing this file is evidence of the WIRING and its fail-closed gates —
 * it is NOT evidence of live YouTube availability or a real platform
 * receipt (Rules 1/2/7/17; R1).
 */

process.env.STPH_DEMO_STORAGE = "1";
// loadOAuthConfig() reads these at call time — in-process test-only values.
process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID = "api-test-client-id.apps.googleusercontent.com";
process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET = "api-test-client-secret-value";
process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL = "https://dashboard.stproduction.test";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { createHash, randomUUID } = await import("node:crypto");
const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const serverModule = await import("../src/catalog/server.js");
// NOTE: read mutable exports (`__demoAdapterForDiagnostics`) off the module
// namespace AFTER configureRuntime() — destructuring would capture the
// pre-boot `null`.
const { default: app, configureRuntime, finalizeRuntimeStartup } = serverModule;
const {
  GOOGLE_OAUTH_ENDPOINTS,
  YOUTUBE_OAUTH_SCOPES,
  createInMemorySecretManager,
  setYouTubeOAuthRuntime,
  YouTubeOAuthService,
} = await import("../src/catalog/youtubeOAuthService.js");
const { ProductionRepository } = await import("../src/catalog/productionRepository.js");
const { PublishingRepository } = await import("../src/catalog/repositories.js");
const { selectMainUploadArtifact } = await import("../src/publishing/youtubePublishExecution.js");

await configureRuntime();
await finalizeRuntimeStartup();

// ---------------------------------------------------------------------------
// Owner session (Rule 6: bearer session + CSRF token for mutations)
// ---------------------------------------------------------------------------

const login = await supertest(app)
  .post("/api/auth/login")
  .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
assert.equal(login.status, 200, "demo owner login must succeed");

const cookieHeader = login.headers["set-cookie"]?.[0] ?? "";
const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
assert.ok(sessionToken, "login must set the session cookie");
assert.ok(login.body.csrfToken, "login must issue a CSRF token for mutations");
const bearerAuth = { Authorization: `Bearer ${sessionToken}` };
const csrfHeader = { "x-csrf-token": login.body.csrfToken };

// ---------------------------------------------------------------------------
// Scripted offline transports (no network, ever)
// ---------------------------------------------------------------------------

const secrets = createInMemorySecretManager();

/** The ONLY video id this test ever sees — returned by the scripted upload. */
const VIDEO_ID = "zQv4Wx7LmN9";
const UPLOAD_RESPONSE_BODY = JSON.stringify({ id: VIDEO_ID });
const SESSION_LOCATION =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&upload_id=demo-session";

/** Every publish-transport call is recorded so tests can prove call counts. */
const publishCalls = [];

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

setYouTubeOAuthRuntime({
  // Google OAuth + channel verification (Issue #206 harness).
  transport: async (request) => {
    if (request.url === GOOGLE_OAUTH_ENDPOINTS.token) {
      return jsonResponse(200, {
        access_token: "ya29.api-test-access-token",
        refresh_token: "1//api-test-refresh-token",
        expires_in: 3600,
        scope: YOUTUBE_OAUTH_SCOPES.join(" "),
      });
    }
    if (request.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
      return jsonResponse(200, {
        items: [{ id: "UCapitestchannel01", snippet: { title: "Public Channel Name", customUrl: "@public-handle" } }],
      });
    }
    if (request.url === GOOGLE_OAUTH_ENDPOINTS.revoke) {
      return { status: 200, body: "" };
    }
    return jsonResponse(404, { error: "unknown_endpoint" });
  },
  secretManagerFactory: () => secrets,
  // The youtubePublisher resumable-upload transport (Issue #215 adapter).
  publishTransport: async (call) => {
    publishCalls.push({ url: call.url, method: call.method });
    if (call.method === "POST") {
      return { status: 200, headers: { location: SESSION_LOCATION }, body: "" };
    }
    if (call.method === "PUT") {
      return { status: 200, headers: {}, body: UPLOAD_RESPONSE_BODY };
    }
    return { status: 404, headers: {}, body: "" };
  },
});

test.after(async () => {
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET;
  delete process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL;
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null, publishTransport: null });
  for (const dir of mediaDirs) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const demoAdapter = serverModule.__demoAdapterForDiagnostics;
assert.ok(demoAdapter, "demo storage adapter must be configured");
const productionRepo = new ProductionRepository(demoAdapter);
const publishingRepo = new PublishingRepository();

const ownerRows = (await demoAdapter.query("SELECT id, email FROM owners", [])).rows;
const ownerId =
  ownerRows.find((row) => row.email === "owner@stproduction.demo")?.id ?? ownerRows[0]?.id;
assert.ok(ownerId, "seeded demo owner must exist");

async function connectOauth(agentId) {
  const start = await supertest(app)
    .post(`/api/youtube/directors/${agentId}/oauth/start`)
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  await supertest(app)
    .get(`/api/youtube/callback?code=api-test-auth-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);
}

await connectOauth("agent-01");

async function createChannel(slug, agentId) {
  const res = await supertest(app)
    .post("/api/channels")
    .set(bearerAuth)
    .set(csrfHeader)
    .send({
      slug,
      displayName: `Route Wire ${slug}`,
      tagline: "Issue 217 route wiring fixture",
      language: "Hindi",
      agentId,
    })
    .expect(201);
  return res.body.channel?.id ?? res.body.channelId ?? res.body.id;
}

const channelAgent01 = await createChannel("route-wire-alpha", "agent-01");
const channelUnconfigured = await createChannel("route-wire-gamma", "agent-03");
const channelIntent = await createChannel("route-wire-delta", "agent-01");

async function createDestination(channelId, platform, handle) {
  const res = await supertest(app)
    .post(`/api/channels/${channelId}/destinations`)
    .set(bearerAuth)
    .set(csrfHeader)
    .send({ platform, handle, isPrimary: true, publicAttribution: "ST Route Lab" })
    .expect(201);
  return res.body.destination?.id ?? res.body.destinationId ?? res.body.id;
}

const destYt = await createDestination(channelAgent01, "youtube", "@stph-route-lab");
const destYtUnconfigured = await createDestination(channelUnconfigured, "youtube", "@stph-route-unconfigured");
const destFacebook = await createDestination(channelIntent, "facebook", "stph-route-lab");

let episodeCursor = 0;
async function createRelease(channelId, title) {
  episodeCursor += 1;
  const res = await supertest(app)
    .post("/api/productions")
    .set(bearerAuth)
    .set(csrfHeader)
    .send({ channelId, title, season: 9, episode: episodeCursor })
    .expect(201);
  return res.body.production;
}

async function moveReleaseToReview(releaseId) {
  const updated = await productionRepo.updateReleaseStatus(ownerId, releaseId, "review");
  assert.equal(updated?.status, "review", "fixture release must reach review status");
}

const mediaDirs = [];
async function mediaFixture(tag) {
  const dir = await mkdtemp(join(tmpdir(), "yt-publish-route-"));
  mediaDirs.push(dir);
  const filePath = join(dir, "main-episode.mp4");
  const content = Buffer.from(`stph-route-wiring-media-${tag}-${randomUUID()}`);
  await writeFile(filePath, content);
  return { filePath, sha256: createHash("sha256").update(content).digest("hex") };
}

let successReleaseId = null;

async function recordAssemblyArtifact(releaseId, { sha256, ffprobeVerified, mediaPath }) {
  return productionRepo.recordArtifact({
    ownerId,
    releaseId,
    kind: "video",
    stage: "assembly",
    sha256,
    ffprobeVerified: ffprobeVerified === true,
    payload: {
      generationMode: "executor_real",
      executorVerified: ffprobeVerified === true,
      ...(typeof mediaPath === "string" ? { storagePath: mediaPath } : {}),
    },
  });
}

function postPublish(releaseId, body, { withCsrf = true } = {}) {
  const req = supertest(app).post(`/api/productions/${releaseId}/publish`).set(bearerAuth);
  if (withCsrf) req.set(csrfHeader);
  return req.send(body);
}

async function getProduction(releaseId) {
  const res = await supertest(app).get(`/api/productions/${releaseId}`).set(bearerAuth).expect(200);
  return res.body;
}

async function auditJson() {
  const res = await supertest(app).get("/api/audit").set(bearerAuth).expect(200);
  return JSON.stringify(Array.isArray(res.body) ? res.body : res.body.events ?? res.body);
}

async function evidenceJson() {
  const res = await supertest(app).get("/api/evidence").set(bearerAuth).expect(200);
  return JSON.stringify(Array.isArray(res.body) ? res.body : res.body.events ?? res.body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("publish mutations reject anonymous and cookie-authenticated callers without a valid CSRF token", async () => {
  await supertest(app)
    .post("/api/productions/some-id/publish")
    .send({ destinationId: destYt })
    .expect(401);

  const release = await createRelease(channelAgent01, "Auth Gate Fixture");
  // Browser-style mutation: session cookie, no Authorization header — the
  // exact scenario the CSRF gate protects (Rule 6).
  const cookieAuth = { Cookie: `session_token=${sessionToken}` };

  const noCsrf = await supertest(app)
    .post(`/api/productions/${release.id}/publish`)
    .set(cookieAuth)
    .send({ destinationId: destYt })
    .expect(403);
  assert.equal(noCsrf.body.error, "CSRF_TOKEN_REQUIRED");

  const badCsrf = await supertest(app)
    .post(`/api/productions/${release.id}/publish`)
    .set(cookieAuth)
    .set("x-csrf-token", "not-the-session-token")
    .send({ destinationId: destYt })
    .expect(403);
  assert.equal(badCsrf.body.error, "INVALID_CSRF_TOKEN");

  // With the valid CSRF token the browser mutation passes the CSRF gate and
  // stops at the Rule 7 publish gate instead (release still planned).
  const okCsrf = await supertest(app)
    .post(`/api/productions/${release.id}/publish`)
    .set(cookieAuth)
    .set(csrfHeader)
    .send({ destinationId: destYt })
    .expect(409);
  assert.equal(okCsrf.body.error, "RELEASE_NOT_READY_FOR_PUBLISH");

  assert.equal(publishCalls.length, 0, "no upload transport call before any gate");
});

test("publish body is strictly validated: unknown fields and oversized captions fail closed", async () => {
  const release = await createRelease(channelAgent01, "Body Validation Fixture");

  const extra = await postPublish(release.id, { destinationId: destYt, visibility: "public" }).expect(400);
  assert.equal(extra.body.error, "REQUEST_VALIDATION_FAILED",
    "visibility can never be client-supplied — private-first is enforced server-side");

  const oversized = await postPublish(release.id, {
    destinationId: destYt,
    captionSnapshot: { title: "t", description: "x".repeat(5000) },
  }).expect(400);
  assert.equal(oversized.body.error, "CAPTION_SNAPSHOT_INVALID");

  assert.equal(publishCalls.length, 0, "validation failures never reach the transport");
});

test("Rule 7 gate blocks a release that is not in review", async () => {
  const release = await createRelease(channelAgent01, "Not Ready Fixture");
  const res = await postPublish(release.id, { destinationId: destYt }).expect(409);
  assert.equal(res.body.error, "RELEASE_NOT_READY_FOR_PUBLISH");

  const check = await getProduction(release.id);
  assert.equal(check.release.status, "planned", "failed publish leaves the release untouched");
  assert.equal(publishCalls.length, 0);
});

test("an FFprobe-unverified artifact never reaches the upload transport", async () => {
  const release = await createRelease(channelAgent01, "Unverified Assembly Fixture");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("unverified");
  await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: false,
    mediaPath: media.filePath,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYt }).expect(409);
  assert.equal(res.body.error, "ARTIFACT_NOT_FFPROBE_VERIFIED");
  assert.equal(publishCalls.length, before, "unverified artifact causes zero network calls");

  const check = await getProduction(release.id);
  assert.equal(check.release.status, "review", "release stays in review after the failed publish");
});

test("a verified artifact with no durable media path fails honestly instead of fabricating an upload", async () => {
  const release = await createRelease(channelAgent01, "No Media Path Fixture");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("no-path");
  await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: true,
    mediaPath: undefined,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYt }).expect(409);
  assert.equal(res.body.error, "ARTIFACT_MEDIA_UNAVAILABLE");
  assert.equal(publishCalls.length, before, "missing media path causes zero network calls");
});

test("an internal agent name in the spoken title is denied at the publishing boundary (Rule 15)", async () => {
  const release = await createRelease(channelAgent01, "JARVIS Overnight Control Room");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("rule15");
  await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: true,
    mediaPath: media.filePath,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYt }).expect(403);
  assert.equal(res.body.error, "AGENT_NAME_LEAKAGE_DENIED");
  assert.equal(publishCalls.length, before, "denied publish causes zero network calls");

  const check = await getProduction(release.id);
  assert.equal(check.release.status, "review", "release stays in review after the denial");
});

test("a private-first YouTube publish executes the wired upload boundary end-to-end", async () => {
  const release = await createRelease(channelAgent01, "Wired Private Upload Fixture");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("success");
  await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: true,
    mediaPath: media.filePath,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYt }).expect(200);

  assert.equal(res.body.production.status, "published");
  const receipt = res.body.receipt;
  assert.equal(receipt.platform, "youtube");
  assert.equal(receipt.platformPostId, VIDEO_ID, "receipt carries the id returned by the transport");
  assert.equal(receipt.platformUrl, `https://www.youtube.com/watch?v=${VIDEO_ID}`);
  assert.equal(receipt.visibility, "private", "first live visibility is private");
  assert.equal(receipt.duplicate, false);
  assert.equal(
    receipt.providerResponseSha256,
    createHash("sha256").update(UPLOAD_RESPONSE_BODY).digest("hex"),
    "receipt binds the exact provider response hash",
  );
  assert.ok(receipt.publishingRequestId, "durable publishing request is referenced");

  assert.equal(publishCalls.length, before + 2, "exactly one session POST + one media PUT");
  assert.equal(publishCalls[before].method, "POST");
  assert.equal(publishCalls[before + 1].method, "PUT");

  const check = await getProduction(release.id);
  assert.equal(check.release.status, "published");
  const eventsJson = JSON.stringify(check.events ?? []);
  assert.ok(eventsJson.includes(VIDEO_ID), "pipeline event records the platform upload");
  assert.ok(eventsJson.includes("platformUpload"), "pipeline event names the platform upload");

  const audit = await auditJson();
  assert.ok(audit.includes("production_publish_recorded"), "publish is audited (Rule 6)");
  assert.ok(audit.includes("platform_upload_succeeded"), "audit records the honest outcome");

  const evidence = await evidenceJson();
  assert.ok(evidence.includes("platform_publish"), "evidence ledger carries the platform publish event");
  assert.ok(evidence.includes(VIDEO_ID), "evidence ledger binds the platform id");
  assert.ok(evidence.includes("private_first"), "evidence records the private-first classification");

  const blob = JSON.stringify([res.body, check]);
  assert.ok(!blob.includes("ya29"), "access token never serializes");
  assert.ok(!blob.includes("1//api-test"), "refresh token never serializes");
  assert.ok(!blob.includes("opaque://") && !blob.includes("vault://"), "secret locators never serialize");

  successReleaseId = release.id;
});

test("re-publishing a published release is refused with zero new network calls", async () => {
  assert.ok(successReleaseId, "success fixture must exist");
  const before = publishCalls.length;
  const res = await postPublish(successReleaseId, { destinationId: destYt }).expect(409);
  assert.equal(res.body.error, "RELEASE_NOT_READY_FOR_PUBLISH");
  assert.equal(publishCalls.length, before, "a published release never re-uploads");
});

test("a durable receipt for the same artifact replays without any network call (no double-publish)", async () => {
  const release = await createRelease(channelAgent01, "Durable Receipt Replay Fixture");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("replay");
  const artifact = await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: true,
    mediaPath: media.filePath,
  });
  assert.ok(artifact?.id, "artifact row must exist for approval binding");

  const priorRequest = await publishingRepo.createRequest({
    artifactId: artifact.id,
    destination: "youtube",
    captionSnapshot: JSON.stringify({ title: "Durable Receipt Replay Fixture" }),
    mode: "private",
    status: "pending",
  });
  await publishingRepo.approveRequest(
    priorRequest.id,
    ownerId,
    new Date(Date.now() + 60000).toISOString(),
  );
  const priorProviderSha = createHash("sha256").update("prior-provider-response").digest("hex");
  await publishingRepo.createReceipt({
    publishingRequestId: priorRequest.id,
    platformPostId: "replayedId0001",
    platformUrl: "https://www.youtube.com/watch?v=replayedId0001",
    providerResponseSha256: priorProviderSha,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYt }).expect(200);
  assert.equal(res.body.receipt.duplicate, true, "existing receipt is replayed as a duplicate");
  assert.equal(res.body.receipt.platformPostId, "replayedId0001");
  assert.equal(res.body.receipt.providerResponseSha256, priorProviderSha);
  assert.equal(res.body.receipt.publishingRequestId, priorRequest.id);
  assert.equal(publishCalls.length, before, "replay performs ZERO network calls");
  assert.equal(res.body.production.status, "published");
});

test("an unconfigured OAuth custody fails honestly at 503 with zero network calls", async () => {
  const release = await createRelease(channelUnconfigured, "Unconfigured Custody Fixture");
  await moveReleaseToReview(release.id);
  const media = await mediaFixture("unconfigured");
  await recordAssemblyArtifact(release.id, {
    sha256: media.sha256,
    ffprobeVerified: true,
    mediaPath: media.filePath,
  });

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destYtUnconfigured }).expect(503);
  assert.equal(res.body.error, "OAUTH_ACCOUNT_NOT_FOUND");
  assert.equal(publishCalls.length, before, "unconfigured custody causes zero network calls");

  const check = await getProduction(release.id);
  assert.equal(check.release.status, "review", "release stays in review after the honest failure");
});

test("non-YouTube destinations keep the original intent-recording behavior", async () => {
  const release = await createRelease(channelIntent, "Intent Only Fixture");
  await moveReleaseToReview(release.id);

  const before = publishCalls.length;
  const res = await postPublish(release.id, { destinationId: destFacebook }).expect(200);
  assert.equal(res.body.production.status, "published");
  assert.equal(res.body.receipt, undefined,
    "no platform receipt is ever claimed without a platform call (R1)");
  assert.equal(publishCalls.length, before, "intent recording performs zero network calls");

  const evidence = await evidenceJson();
  assert.ok(evidence.includes("publish_intent_recorded"), "intent evidence is recorded");
});

test("selectMainUploadArtifact picks the newest verified assembly video and fails closed otherwise", () => {
  assert.throws(() => selectMainUploadArtifact(undefined), /ASSEMBLY_ARTIFACT_MISSING/);
  assert.throws(() => selectMainUploadArtifact([]), /ASSEMBLY_ARTIFACT_MISSING/);
  assert.throws(
    () => selectMainUploadArtifact([{ kind: "video", stage: "reel", ffprobeVerified: true }]),
    /ASSEMBLY_ARTIFACT_MISSING/,
    "reels are never the main upload artifact",
  );
  assert.throws(
    () => selectMainUploadArtifact([{ kind: "video", stage: "assembly", ffprobeVerified: false }]),
    /ARTIFACT_NOT_FFPROBE_VERIFIED/,
  );

  const newest = { kind: "video", stage: "assembly", ffprobeVerified: true, id: "new" };
  const older = { kind: "video", stage: "assembly", ffprobeVerified: true, id: "old" };
  const unverified = { kind: "video", stage: "assembly", ffprobeVerified: false, id: "bad" };
  assert.equal(
    selectMainUploadArtifact([older, unverified, newest]).id,
    "new",
    "the newest ffprobe-verified assembly video wins",
  );
});

test("publishing token resolution is fail-closed at the secret-manager boundary", async () => {
  const service = new YouTubeOAuthService({ db: demoAdapter });

  await assert.rejects(
    () => service.getPublishingAccessToken({ ownerId: null, agentId: "agent-01" }),
    (err) => { assert.equal(err.code, "REQUEST_VALIDATION_FAILED"); return true; },
  );
  await assert.rejects(
    () => service.getPublishingAccessToken({ ownerId, agentId: "agent-does-not-exist" }),
    (err) => { assert.equal(err.code, "OAUTH_ACCOUNT_NOT_FOUND"); return true; },
  );

  const token = await service.getPublishingAccessToken({ ownerId, agentId: "agent-01" });
  assert.equal(token, "ya29.api-test-access-token",
    "the token resolves ONLY through the secret-manager boundary (Rule 17)");

  // A connected-then-revoked Director must fail closed.
  await connectOauth("agent-04");
  await supertest(app)
    .post("/api/youtube/directors/agent-04/revoke")
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  await assert.rejects(
    () => service.getPublishingAccessToken({ ownerId, agentId: "agent-04" }),
    (err) => { assert.equal(err.code, "OAUTH_ACCOUNT_NOT_CONNECTED"); return true; },
  );

  // Unconfigured custody: fail honestly, never fabricate a token.
  setYouTubeOAuthRuntime({ secretManagerFactory: null });
  try {
    await assert.rejects(
      () => service.getPublishingAccessToken({ ownerId, agentId: "agent-01" }),
      (err) => { assert.equal(err.code, "SECRET_MANAGER_NOT_CONFIGURED"); return true; },
    );
  } finally {
    setYouTubeOAuthRuntime({ secretManagerFactory: () => secrets });
  }
});
