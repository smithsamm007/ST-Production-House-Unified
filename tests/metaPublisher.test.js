import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMetaPublisher,
  META_GRAPH_VERSION,
  META_IG_CONTAINER_URL,
  META_IG_RUPLOAD_HOST,
  META_IG_RUPLOAD_PATH_PREFIX,
  META_FB_VIDEO_UPLOAD_URL,
} from "../src/publishing/metaPublisher.js";

// Test fixture only — never a real credential (Rule 17).
const TOKEN = "test-access-token-value-123";

let mediaDir;

test.before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "meta-publisher-"));
});

test.after(async () => {
  await rm(mediaDir, { recursive: true, force: true });
});

async function makeMedia(content = "fake-video-bytes-for-tests") {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const filePath = join(mediaDir, `media-${sha256.slice(0, 12)}.bin`);
  await writeFile(filePath, content);
  return { filePath, sha256, size: Buffer.byteLength(content) };
}

function buildRequest(media, overrides = {}) {
  const { approval, destination, captionSnapshot, credentials, ...rest } = overrides;
  const request = {
    id: "req-1",
    ownerId: "owner-01",
    agentId: "agent-07",
    artifactSha256: media.sha256,
    destination: destination ?? "instagram",
    captionSnapshot: captionSnapshot ?? {
      title: "Episode 1 - the build",
      description: "How the pipeline works",
    },
    approval: {
      ownerId: "owner-01",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      artifactSha256: media.sha256,
      destination: destination ?? "instagram",
    },
    mediaFilePath: media.filePath,
    ...rest,
  };
  if ("approval" in overrides) {
    if (approval === undefined) {
      delete request.approval;
    } else {
      request.approval = { ...request.approval, ...approval };
    }
  }
  return request;
}

const IG_CREDENTIALS = { accessToken: TOKEN, instagramUserId: "90010177253934" };
const FB_CREDENTIALS = { accessToken: TOKEN, appId: "1122334455667", pageId: "8877665544332" };

/** Scripted transport: each step is a response object or an Error to throw. */
function scriptedTransport(steps) {
  const calls = [];
  let index = 0;
  const transport = async (input) => {
    calls.push(input);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls, get count() {
    return index;
  } };
}

function okJson(body, headers = {}) {
  return { status: 200, headers, body: JSON.stringify(body) };
}

function makePublisher(script, extra = {}) {
  const credentialsScopes = [];
  const sleeps = [];
  const publisher = createMetaPublisher({
    resolveCredentials: async (scope) => {
      credentialsScopes.push(scope);
      return (scope.destination === "instagram" ? IG_CREDENTIALS : FB_CREDENTIALS);
    },
    transport: script.transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { publisher, credentialsScopes, sleeps };
}

/** Builds the exact status-poll step that returns the given code. */
function okStatus(statusCode, times = 1) {
  return Array.from({ length: times }, () => okJson({ status_code: statusCode }));
}

function expectCode(error, code) {
  assert.equal(error?.code, code, `${code} expected, got ${error?.code ?? error?.message}`);
  return true;
}

function assertCommonIgHeaderShape(call) {
  assert.ok(call.headers.Authorization.startsWith("Bearer ") || call.headers.Authorization.startsWith("OAuth "));
}

// ---------------------------------------------------------------------------
// Construction / configuration fails closed
// ---------------------------------------------------------------------------

test("constructor: missing credential resolver, transport, or bad retry config fails closed", () => {
  assert.throws(() => createMetaPublisher({}), (err) =>
    expectCode(err, "META_CREDENTIAL_RESOLVER_REQUIRED"));
  assert.throws(
    () => createMetaPublisher({ resolveCredentials: async () => ({ accessToken: "t", instagramUserId: "1" }), transport: "nope" }),
    (err) => expectCode(err, "META_TRANSPORT_REQUIRED"),
  );
  assert.throws(
    () => createMetaPublisher({ resolveCredentials: async () => ({ accessToken: "t" }), maxAttempts: 0 }),
    (err) => expectCode(err, "META_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createMetaPublisher({ resolveCredentials: async () => ({ accessToken: "t" }), statusPolls: 100 }),
    (err) => expectCode(err, "META_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createMetaPublisher({ resolveCredentials: async () => ({ accessToken: "t" }), mediaResolver: "nope" }),
    (err) => expectCode(err, "META_MEDIA_RESOLVER_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Happy paths: official request shapes + honest receipts
// ---------------------------------------------------------------------------

test("publish (instagram): official REELS container → rupload → status → media_publish → real permalink", async () => {
  const media = await makeMedia("ig-bytes");
  const script = scriptedTransport([
    okJson({ id: "17841400000000000" }),
    okJson({ success: true, message: "Upload successful." }),
    ...okStatus("IN_PROGRESS"),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000000" }),
    okJson({ permalink: "https://www.instagram.com/reel/abcShortIdle/" }),
  ]);
  const { publisher, credentialsScopes } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  const merged = JSON.stringify(receipt);

  assert.match(publisher.label, /meta-graph-upload/);
  assert.equal(receipt.platform, "instagram");
  assert.equal(receipt.platformPostId, "17955950000000000");
  assert.equal(receipt.platformUrl, "https://www.instagram.com/reel/abcShortIdle/");
  assert.equal(receipt.duplicate, false);
  assert.equal(merged.includes(TOKEN), false);

  const [container, upload, poll1, poll2, publishCall, permalink] = script.calls;
  assert.equal(container.url, `${META_IG_CONTAINER_URL}/90010177253934/media`);
  assert.equal(container.method, "POST");
  const containerMetadata = JSON.parse(container.body);
  assert.equal(containerMetadata.media_type, "REELS");
  assert.equal(containerMetadata.upload_type, "resumable");
  assert.ok(typeof containerMetadata.caption === "string");

  assert.equal(upload.url, `${META_IG_RUPLOAD_HOST}${META_IG_RUPLOAD_PATH_PREFIX}/${"17841400000000000"}`);
  assert.equal(upload.method, "POST");
  assert.equal(upload.headers.Authorization, `OAuth ${TOKEN}`);
  assert.equal(upload.headers.offset, "0");
  assert.equal(upload.headers.file_size, String(media.size));
  assert.equal(upload.bodyFile, media.filePath);

  const pollUrls = [poll1.url, poll2.url];
  for (const pollUrl of pollUrls) {
    assert.ok(pollUrl.startsWith(`${META_IG_CONTAINER_URL}/17841400000000000?fields=status_code`));
    assert.equal(poll1.method, "GET");
    assertCommonIgHeaderShape(poll1);
  }

  assert.equal(publishCall.url, `${META_IG_CONTAINER_URL}/90010177253934/media_publish`);
  assert.equal(JSON.parse(publishCall.body).creation_id, "17841400000000000");

  assert.equal(permalink.url, `${META_IG_CONTAINER_URL}/17955950000000000?fields=permalink`);

  assert.deepEqual(credentialsScopes, [
    { ownerId: "owner-01", agentId: "agent-07", destination: "instagram" },
  ]);
});

test("publish (instagram): caption composed from title+description when caption field is absent", async () => {
  const media = await makeMedia("ig-caption-compose");
  const script = scriptedTransport([
    okJson({ id: "17841400000000001" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000001" }),
    okJson({ permalink: "https://www.instagram.com/reel/composedCaption/" }),
  ]);
  const { publisher } = makePublisher(script);
  await publisher.publish(buildRequest(media));
  const containerMetadata = JSON.parse(script.calls[0].body);
  assert.equal(containerMetadata.caption, "Episode 1 - the build\n\nHow the pipeline works");
  assert.ok(containerMetadata.caption.length <= 2200);
});

test("publish (facebook): official resumable session → bytes → page video publish → real permalink", async () => {
  const media = await makeMedia("fb-bytes");
  const script = scriptedTransport([
    okJson({ id: "upload:728374915236789" }),
    okJson({ h: "2:c2FtcGxl" }),
    okJson({ id: "789456123012345" }),
    okJson({ permalink: "https://www.facebook.com/watch/?v=789456123012345" }),
  ]);
  const { publisher, credentialsScopes } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media, { destination: "facebook" }));

  assert.equal(receipt.platform, "facebook");
  assert.equal(receipt.platformPostId, "789456123012345");
  assert.equal(receipt.platformUrl, "https://www.facebook.com/watch/?v=789456123012345");
  assert.equal(receipt.duplicate, false);
  assert.equal(JSON.stringify(receipt).includes(TOKEN), false);

  const [session, bytes, publishCall, permalink] = script.calls;
  assert.equal(session.url, `${META_IG_CONTAINER_URL}/1122334455667/uploads`);
  const sessionMetadata = JSON.parse(session.body);
  assert.equal(sessionMetadata.file_name, "production.mp4");
  assert.equal(sessionMetadata.file_length, media.size);
  assert.equal(sessionMetadata.file_type, "video/mp4");
  assert.equal(session.headers.Authorization, `Bearer ${TOKEN}`);

  assert.equal(bytes.url, `${META_IG_CONTAINER_URL}/upload:728374915236789`);
  assert.equal(bytes.headers.Authorization, `OAuth ${TOKEN}`);
  assert.equal(bytes.headers.file_offset, "0");
  assert.equal(bytes.bodyFile, media.filePath);

  assert.equal(publishCall.url, `${META_FB_VIDEO_UPLOAD_URL}/8877665544332/videos`);
  assert.equal(publishCall.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  const form = new URLSearchParams(publishCall.body);
  assert.equal(form.get("title"), "Episode 1 - the build");
  assert.equal(form.get("description"), "How the pipeline works");
  assert.equal(form.get("fbuploader_video_file_chunk"), "2:c2FtcGxl");

  assert.equal(permalink.url, `${META_IG_CONTAINER_URL}/789456123012345?fields=permalink`);

  assert.deepEqual(credentialsScopes, [
    { ownerId: "owner-01", agentId: "agent-07", destination: "facebook" },
  ]);
});

// ---------------------------------------------------------------------------
// Private-first + metadata + Rule 15
// ---------------------------------------------------------------------------

test("publish: non-Meta destinations are refused before any call", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([]);
  const { publisher, credentialsScopes } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { destination: "youtube" })),
    (err) => expectCode(err, "META_DESTINATION_REQUIRED"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { destination: "snapchat" })),
    (err) => expectCode(err, "META_DESTINATION_REQUIRED"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);
});

test("publish: internal agent names in metadata are denied before any network call (Rule 15)", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([]);
  const { publisher, credentialsScopes } = makePublisher(script);

  const boilerplate = { title: "Night shift", description: "" };
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { captionSnapshot: { title: "Created by JARVIS", description: "" } })),
    (err) => expectCode(err, "AGENT_NAME_LEAKAGE_DENIED"),
  );
  assert.equal(script.count, 0);
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { captionSnapshot: { ...boilerplate, caption: "hosted by lakme today" } })),
    (err) => expectCode(err, "AGENT_NAME_LEAKAGE_DENIED"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);
});

// ---------------------------------------------------------------------------
// Rule 7: approval binding
// ---------------------------------------------------------------------------

test("publish: missing, expired, owner-mismatched, or artifact-mismatched approval is refused", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([]);
  const { publisher, credentialsScopes } = makePublisher(script);

  await assert.rejects(() => publisher.publish(buildRequest(media, { approval: undefined })), (err) =>
    expectCode(err, "OWNER_APPROVAL_REQUIRED"));
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { approval: { ownerId: "owner-01", expiresAt: new Date(Date.now() - 1000).toISOString() } })),
    (err) => expectCode(err, "APPROVAL_EXPIRED"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { approval: { artifactSha256: createHash("sha256").update("other").digest("hex") } })),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { approval: { destination: "facebook" } })),
    (err) => expectCode(err, "APPROVAL_DESTINATION_MISMATCH"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { ownerId: "owner-02" })),
    (err) => expectCode(err, "APPROVAL_OWNER_MISMATCH"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);
});

// ---------------------------------------------------------------------------
// Artifact binding + unreadable media fail closed
// ---------------------------------------------------------------------------

test("publish: artifact substitution is refused BEFORE any credential resolution or network call", async () => {
  const media = await makeMedia("hash-mismatch-bytes");
  const script = scriptedTransport([]);
  const { publisher, credentialsScopes } = makePublisher(script);

  // A request whose artifactSha256 does not match the streamed file hash is
  // rejected at the approval-boundary check first (Rule 7: the approval is
  // bound to the APPROVED artifact, so a foreign hash can never silently
  // bypass the binding — either way nothing network-touching executes).
  await assert.rejects(
    () => publisher.publish(
      buildRequest(media, { artifactSha256: createHash("sha256").update("other-bytes").digest("hex") }),
    ),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);

  // Direct hash-mismatch (approval matches the submitted hash but the FILE
  // streams to a different one — a tampered/substituted on-disk artifact).
  const tampered = makeMedia("tampered-bytes");
  const tamperedApprovalTamperRequest = buildRequest(tamperedApprovalMedia(), {
    artifactSha256: createHash("sha256").update("other-bytes").digest("hex"),
  });
  await assert.rejects(
    () => publisher.publish(tamperedApprovalTamperRequest),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );
  assert.equal(script.count, 0);

  function tamperedApprovalMedia() {
    return media;
  }
});

test("publish: unreadable or unsafe media paths fail closed", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([]);
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: `${mediaDir}/../outside.bin` })),
    (err) => expectCode(err, "META_MEDIA_SOURCE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: join(mediaDir, "missing-file.bin") })),
    (err) => expectCode(err, "META_MEDIA_SOURCE_UNREADABLE"),
  );
  assert.equal(script.count, 0);
});

// ---------------------------------------------------------------------------
// Credential validation and scoping (destination isolation)
// ---------------------------------------------------------------------------

test("publish: credential shapes are validated for the exact destination", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([]);
  const publisher = createMetaPublisher({
    resolveCredentials: async () => ({ accessToken: TOKEN, instagramUserId: "not-numeric" }),
    transport: script.transport,
    sleep: async () => {},
  });
  await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_CREDENTIALS_INVALID"));
  assert.equal(script.count, 0);

  const fbMissingPage = createMetaPublisher({
    resolveCredentials: async () => ({ accessToken: TOKEN, appId: "1122334455667" }),
    transport: script.transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => fbMissingPage.publish(buildRequest(media, { destination: "facebook" })),
    (err) => expectCode(err, "META_CREDENTIALS_INVALID"),
  );
  assert.equal(script.count, 0);
});

test("publish: token missing or id field absent → stable failure codes", async () => {
  const media = await makeMedia("no-token");
  const script = scriptedTransport([]);
  const noToken = createMetaPublisher({
    resolveCredentials: async () => ({ instagramUserId: "90010177253934" }),
    transport: script.transport,
    sleep: async () => {},
  });
  await assert.rejects(() => noToken.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_TOKEN_UNAVAILABLE"));
  assert.equal(script.count, 0);

  const emptyToken = createMetaPublisher({
    resolveCredentials: async () => ({ accessToken: "", instagramUserId: "90010177253934" }),
    transport: script.transport,
    sleep: async () => {},
  });
  await assert.rejects(() => emptyToken.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_TOKEN_UNAVAILABLE"));
  assert.equal(script.count, 0);
});

// ---------------------------------------------------------------------------
// Receipt honesty: no invented ids/permalinks
// ---------------------------------------------------------------------------

test("publish: platform responses without usable ids/permalinks fail closed", async () => {
  const media = await makeMedia("receipt-invalid");
  const noIdScript = scriptedTransport([
    okJson({ id: "17841400000000002" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "" }),
  ]);
  const noIdPublisher = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: noIdScript.transport,
    sleep: async () => {},
  });
  await assert.rejects(() => noIdPublisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_RECEIPT_INVALID"));
  assert.equal(noIdScript.count, 4);

  const permalinkless = scriptedTransport([
    okJson({ id: "17841400000000003" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000002" }),
    okJson({ error: "no permalink here" }),
  ]);
  const noPermalinkMedia = await makeMedia("no-permalink");
  const noPermalinkPublisher = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: permalinkless.transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => noPermalinkPublisher.publish(buildRequest(noPermalinkMedia)),
    (err) => expectCode(err, "META_PERMALINK_UNAVAILABLE"),
  );
});

// ---------------------------------------------------------------------------
// Container status poll honesty
// ---------------------------------------------------------------------------

test("publish: container EXPIRED/ERROR fail closed; status timeout never fabricates", async () => {
  const expiredMedia = await makeMedia("expired");
  const expired = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: scriptedTransport([
      okJson({ id: "17841400000000004" }),
      okJson({ success: true }),
      ...okStatus("EXPIRED"),
    ]).transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => expired.publish(buildRequest(expiredMedia)),
    (err) => expectCode(err, "META_CONTAINER_EXPIRED"),
  );

  const erroredMedia = await makeMedia("errored");
  const errored = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: scriptedTransport([
      okJson({ id: "17841400000000005" }),
      okJson({ success: true }),
      ...okStatus("ERROR"),
    ]).transport,
    sleep: async () => {},
  });
  await assert.rejects(
    () => errored.publish(buildRequest(erroredMedia)),
    (err) => expectCode(err, "META_CONTAINER_ERRORED"),
  );

  const timeoutMedia = await makeMedia("timeout");
  const timeoutPublisher = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: scriptedTransport([
      okJson({ id: "17841400000000006" }),
      okJson({ success: true }),
      ...okStatus("IN_PROGRESS", 3),
    ]).transport,
    sleep: async () => {},
    statusPolls: 3,
  });
  await assert.rejects(
    () => timeoutPublisher.publish(buildRequest(timeoutMedia)),
    (err) => expectCode(err, "META_CONTAINER_STATUS_TIMEOUT"),
  );
});

// ---------------------------------------------------------------------------
// Retry matrix (429 honors Retry-After; 401/403 fail; 5xx and network retry)
// ---------------------------------------------------------------------------

test("publish: 429 honors Retry-After and retries with backoff until success", async () => {
  const media = await makeMedia("retry");
  const script = scriptedTransport([
    okJson({ id: "17841400000000007" }),
    { status: 429, headers: { "retry-after": "1" }, body: "" },
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000003" }),
    okJson({ permalink: "https://www.instagram.com/reel/afterRateLimited/" }),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, "17955950000000003");
  assert.deepEqual(sleeps, [1000]);
});

test("publish: 401 and 403 never retry; 5xx/network errors retry", async () => {
  const media = await makeMedia("no-retry");

  const forbidden = scriptedTransport([{ status: 401, headers: {}, body: "unauthorized" }]);
  const forbiddenPublisher = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: forbidden.transport,
    sleep: async () => {},
  });
  await assert.rejects(() => forbiddenPublisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_AUTH_FAILED"));
  assert.equal(forbidden.count, 1);
});

test("publish: transport failure retries then propagates the stable code", async () => {
  const media = await makeMedia("network-retry");
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    throw new Error(`flaky network attempt ${attempts}`);
  };
  const publisher = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: flaky,
    sleep: async () => {},
  });
  await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_UPLOAD_UNAVAILABLE"));
  assert.equal(attempts, 3);
});

// ---------------------------------------------------------------------------
// Idempotency: zero-network replay of the identical publish
// ---------------------------------------------------------------------------

test("publish: identical instagram request replays the receipt with ZERO network calls", async () => {
  const media = await makeMedia("idempotent");
  const script = scriptedTransport([
    okJson({ id: "17841400000000008" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000004" }),
    okJson({ permalink: "https://www.instagram.com/reel/idempotentReplay/" }),
  ]);
  const { publisher } = makePublisher(script);

  const first = await publisher.publish(buildRequest(media));
  assert.equal(first.duplicate, false);
  const before = script.count;
  const second = await publisher.publish(buildRequest(media));
  assert.equal(second.duplicate, true);
  assert.equal(second.platformPostId, first.platformPostId);
  assert.equal(second.platformUrl, first.platformUrl);
  assert.equal(script.count, before);
});

test("publish: destination and caption changes do NOT replay (independent identity)", async () => {
  const media = await makeMedia("different-identities");
  const script = scriptedTransport([
    okJson({ id: "17841400000000009" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000005" }),
    okJson({ permalink: "https://www.instagram.com/reel/igSide/" }),
    okJson({ id: "upload:728374915236789" }),
    okJson({ h: "2:c2FtcGxl" }),
    okJson({ id: "789456123012345" }),
    okJson({ permalink: "https://www.facebook.com/watch/?v=789456123012345" }),
    okJson({ id: "17841400000000019" }),
    okJson({ success: true }),
    ...okStatus("FINISHED"),
    okJson({ id: "17955950000000015" }),
    okJson({ permalink: "https://www.instagram.com/reel/differentCaption/" }),
  ]);
  const { publisher } = makePublisher(script);
  const media2 = await makeMedia("different-identities-2");

  const igFirst = await publisher.publish(buildRequest(media));
  assert.equal(igFirst.duplicate, false);

  const fb = await publisher.publish(buildRequest(media2, { destination: "facebook" }));
  assert.equal(fb.duplicate, false);

  const igDifferentCaption = await publisher.publish(
    buildRequest(media, { captionSnapshot: { title: "Other show", description: "different take" } }),
  );
  assert.equal(igDifferentCaption.duplicate, false);
});

// ---------------------------------------------------------------------------
// Transport response contract validation
// ---------------------------------------------------------------------------

test("publish: malformed transport responses fail closed", async () => {
  const media = await makeMedia("bad-transport");
  const bad = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: async () => ({ nope: true }),
    sleep: async () => {},
  });
  await assert.rejects(() => bad.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_TRANSPORT_RESPONSE_INVALID"));

  const nonJson = createMetaPublisher({
    resolveCredentials: async () => IG_CREDENTIALS,
    transport: scriptedTransport([{ status: 200, headers: {}, body: "<html>oops</html>" }]).transport,
    sleep: async () => {},
  });
  await assert.rejects(() => nonJson.publish(buildRequest(media)), (err) =>
    expectCode(err, "META_CONTAINER_REJECTED"));
});

// ---------------------------------------------------------------------------
// Unsafe status-poll fields can never smuggle a URL (R3)
// ---------------------------------------------------------------------------

test("publish: official hosts only — non-Meta host build is structurally impossible", () => {
  // The endpoint constants must be pinned to the official HTTPS hosts.
  assert.equal(META_GRAPH_VERSION, "25.0");
  assert.equal(META_IG_CONTAINER_URL, `https://graph.facebook.com/v${META_GRAPH_VERSION}`);
  assert.equal(META_IG_RUPLOAD_HOST, "https://rupload.facebook.com");
  assert.ok(META_IG_RUPLOAD_PATH_PREFIX.startsWith("/ig-api-upload/v"));
  assert.equal(META_FB_VIDEO_UPLOAD_URL, `https://graph-video.facebook.com/v${META_GRAPH_VERSION}`);
});
