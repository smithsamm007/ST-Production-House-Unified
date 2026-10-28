import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBilibiliPublisher,
  BILI_MEMBER_API_BASE,
  BILI_VIDEO_URL_BASE,
} from "../src/publishing/bilibiliPublisher.js";

// Test fixture only — never a real credential (Rule 17).
const TOKEN = "test-bilibili-access-token-123";
const UPLOAD_TOKEN = "upload-token-abcdef0123456789";
// Fixture archive id / bvid — never a real platform-issued id (Rule 2).
const RESOURCE_ID = "3141592653";
const BVID = "BV1fixture123";

let mediaDir;

test.before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "bilibili-publisher-"));
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
  const { approval, captionSnapshot, ...rest } = overrides;
  const request = {
    id: "req-1",
    ownerId: "owner-01",
    agentId: "agent-07",
    artifactSha256: media.sha256,
    destination: "bilibili",
    captionSnapshot: captionSnapshot ?? {
      title: "Episode 1 - the build",
      description: "How the pipeline works",
    },
    tid: "17", // fixture 分区 id from the official 分区查询 interface
    approval: {
      ownerId: "owner-01",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      artifactSha256: media.sha256,
      destination: "bilibili",
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

const CREDENTIALS = { accessToken: TOKEN };

const OK_PREPROCESS = { code: 0, message: "0", data: { upload_token: UPLOAD_TOKEN } };
const OK_PART = { code: 0, message: "0" };
const OK_SUBMIT = {
  code: 0,
  message: "0",
  data: { resource_id: RESOURCE_ID, bvid: BVID },
};

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
  return { transport, calls, get count() { return index; } };
}

function okJson(body, headers = {}) {
  return { status: 200, headers, body: JSON.stringify(body) };
}

/**
 * Official 4-step script: preprocess → N 8 MB parts → merge → submission.
 * `parts` must match the number of 8 MB parts the media will produce.
 */
function biliScript({ parts = 1, submit = OK_SUBMIT } = {}) {
  return [
    okJson(OK_PREPROCESS),
    ...Array.from({ length: parts }, () => okJson(OK_PART)),
    okJson(OK_PART),
    okJson(submit),
  ];
}

function makePublisher(script, extra = {}) {
  const credentialsScopes = [];
  const sleeps = [];
  const publisher = createBilibiliPublisher({
    resolveCredentials: async (scope) => {
      credentialsScopes.push(scope);
      return CREDENTIALS;
    },
    transport: script.transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { publisher, credentialsScopes, sleeps };
}

function expectCode(error, code) {
  assert.equal(error?.code, code, `${code} expected, got ${error?.code ?? error?.message}`);
  return true;
}

/** The media name is derived from the artifact hash (Rule 15 — no metadata leak). */
function preprocessBodyName(media) {
  return `stph-${media.sha256.slice(0, 16)}.mp4`;
}

// ---------------------------------------------------------------------------
// Construction / configuration fails closed
// ---------------------------------------------------------------------------

test("constructor: missing resolver, transport, bad signer, or bad retry config fails closed", () => {
  assert.throws(
    () => createBilibiliPublisher({}),
    (err) => expectCode(err, "BILIBILI_CREDENTIAL_RESOLVER_REQUIRED"),
  );
  assert.throws(
    () => createBilibiliPublisher({ resolveCredentials: async () => CREDENTIALS, transport: "nope" }),
    (err) => expectCode(err, "BILIBILI_TRANSPORT_REQUIRED"),
  );
  assert.throws(
    () => createBilibiliPublisher({ resolveCredentials: async () => CREDENTIALS, signRequest: "nope" }),
    (err) => expectCode(err, "BILIBILI_SIGNER_INVALID"),
  );
  assert.throws(
    () => createBilibiliPublisher({ resolveCredentials: async () => CREDENTIALS, maxAttempts: 0 }),
    (err) => expectCode(err, "BILIBILI_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createBilibiliPublisher({ resolveCredentials: async () => CREDENTIALS, maxAttempts: 6 }),
    (err) => expectCode(err, "BILIBILI_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createBilibiliPublisher({ resolveCredentials: async () => CREDENTIALS, mediaResolver: "nope" }),
    (err) => expectCode(err, "BILIBILI_MEDIA_RESOLVER_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Happy path: official request shapes + honest receipt
// ---------------------------------------------------------------------------

test("publish: official preprocess → parts → merge → submission with an honest review-pending receipt", async () => {
  const media = await makeMedia();
  const script = scriptedTransport(biliScript());
  const { publisher, credentialsScopes } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));

  // Credential scope is director-bound and destination-bound.
  assert.deepEqual(credentialsScopes, [
    { ownerId: "owner-01", agentId: "agent-07", destination: "bilibili" },
  ]);

  // Step 1: official preprocess call with the artifact-derived media name.
  const preprocess = script.calls[0];
  assert.equal(
    preprocess.url,
    `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/init?name=${encodeURIComponent(preprocessBodyName(media))}&utype=1`,
  );
  assert.equal(preprocess.method, "POST");
  assert.equal(preprocess.headers.Authorization, `Bearer ${TOKEN}`);
  const preprocessBody = JSON.parse(preprocess.body);
  assert.match(preprocessBody.name, /^stph-[0-9a-f]{16}\.mp4$/);
  assert.equal(preprocessBody.utype, 1);

  // Step 2: official part upload with the official query shape.
  const part = script.calls[1];
  assert.equal(
    part.url,
    `${BILI_MEMBER_API_BASE}/video/v2/part/upload?part_number=1&upload_token=${encodeURIComponent(UPLOAD_TOKEN)}`,
  );
  assert.equal(part.method, "POST");
  assert.equal(part.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(part.headers["Content-Type"], "application/octet-stream");
  assert.equal(part.body.length, media.size); // ≤ 8 MB for the fixture file

  // Step 3: official merge on the pinned host.
  const merge = script.calls[2];
  assert.equal(
    merge.url,
    `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/complete?upload_token=${encodeURIComponent(UPLOAD_TOKEN)}`,
  );
  assert.equal(merge.method, "POST");

  // Step 4: official submission body shape.
  const submit = script.calls[3];
  assert.equal(submit.url, `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/add-by-utoken`);
  const submitBody = JSON.parse(submit.body);
  assert.equal(submitBody.title, "Episode 1 - the build");
  assert.equal(submitBody.tid, 17);
  assert.equal(submitBody.copyright, 1);
  assert.equal(submitBody.no_reprint, 1);
  assert.equal(submitBody.desc, "How the pipeline works");
  assert.equal(submitBody.cover, undefined);

  // Honest receipt: REAL archive id + review-pending state; URL only from
  // the real bvid, built from the pinned base.
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  assert.equal(receipt.platformUrl, `${BILI_VIDEO_URL_BASE}${BVID}`);
  assert.equal(receipt.submissionState, "submitted_review_pending");
  assert.deepEqual(JSON.parse(receipt.rawResponse), OK_SUBMIT);
  // Token containment (Rule 17): the receipt never carries the credential.
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
});

test("publish: submission WITHOUT bvid emits no platformUrl — honest absence, never fabricated", async () => {
  const media = await makeMedia("resource-id-only");
  const script = scriptedTransport(
    biliScript({ submit: { code: 0, message: "0", data: { resource_id: RESOURCE_ID } } }),
  );
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  assert.equal(receipt.platformUrl, undefined);
  assert.equal(receipt.submissionState, "submitted_review_pending");
});

test("publish: aid-only submission response yields the real numeric id, still no public URL", async () => {
  const media = await makeMedia("aid-only");
  const script = scriptedTransport(
    biliScript({ submit: { code: 0, message: "0", data: { aid: 170001 } } }),
  );
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, "170001");
  assert.equal(receipt.platformUrl, undefined);
});

test("publish: 8MB+1 media splits into two ≤8MB official parts with the 1-based sequence", async () => {
  const bigContent = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
  const media = await makeMedia(bigContent);
  const script = scriptedTransport(biliScript({ parts: 2 }));
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(script.count, 5); // preprocess + 2 parts + merge + submit
  const part1 = script.calls[1];
  const part2 = script.calls[2];
  assert.ok(part1.url.includes("part_number=1"));
  assert.ok(part2.url.includes("part_number=2"));
  assert.equal(part1.body.length, 8 * 1024 * 1024);
  assert.equal(part2.body.length, 1);
  assert.equal(receipt.platformPostId, RESOURCE_ID);
});

// ---------------------------------------------------------------------------
// Rule 7: approval binding inside the adapter (defense-in-depth)
// ---------------------------------------------------------------------------

test("approval: expired, artifact-mismatched, destination-mismatched, or owner-mismatched fails closed", async () => {
  const media = await makeMedia("approval-binding");

  const expired = makePublisher(biliScript()).publisher;
  await assert.rejects(
    () =>
      expired.publish(
        buildRequest(media, {
          approval: { expiresAt: new Date(Date.now() - 1000).toISOString() },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_EXPIRED"),
  );

  const mismatched = makePublisher(biliScript()).publisher;
  await assert.rejects(
    () =>
      mismatched.publish(
        buildRequest(media, {
          approval: { artifactSha256: "a".repeat(64) },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );

  const wrongDestination = makePublisher(biliScript()).publisher;
  await assert.rejects(
    () =>
      wrongDestination.publish(
        buildRequest(media, { approval: { destination: "youtube" } }),
      ),
    (err) => expectCode(err, "APPROVAL_DESTINATION_MISMATCH"),
  );

  const wrongOwner = makePublisher(biliScript()).publisher;
  await assert.rejects(
    () =>
      wrongOwner.publish(
        buildRequest(media, { ownerId: "owner-02", approval: { ownerId: "owner-01" } }),
      ),
    (err) => expectCode(err, "APPROVAL_OWNER_MISMATCH"),
  );
});

// ---------------------------------------------------------------------------
// Rule 15 + artifact binding: gates run BEFORE any network or credential use
// ---------------------------------------------------------------------------

test("rule 15: internal agent names in metadata fail closed before any network call", async () => {
  const media = await makeMedia("agent-leak");
  const script = scriptedTransport(biliScript());
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { captionSnapshot: { title: "brought to you by JARVIS" } }),
      ),
    (err) => expectCode(err, "AGENT_NAME_LEAKAGE_DENIED"),
  );
  assert.equal(script.count, 0);
});

test("artifact binding: substituted file bytes fail before credential resolution", async () => {
  const media = await makeMedia("real-bytes");
  const script = scriptedTransport(biliScript());
  const { publisher, credentialsScopes } = makePublisher(script);
  const other = await makeMedia("substituted-bytes");

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: other.filePath })),
    (err) => expectCode(err, "BILIBILI_MEDIA_HASH_MISMATCH"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);
});

test("request validation: destination, tid, metadata, and cover fail closed", async () => {
  const media = await makeMedia("validation");
  const publisher = makePublisher(biliScript()).publisher;

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { destination: "youtube" })),
    (err) => expectCode(err, "BILIBILI_DESTINATION_REQUIRED"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { tid: undefined })),
    (err) => expectCode(err, "BILIBILI_TID_REQUIRED"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { tid: "not-a-number" })),
    (err) => expectCode(err, "BILIBILI_TID_REQUIRED"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { captionSnapshot: { title: "" } })),
    (err) => expectCode(err, "BILIBILI_METADATA_INVALID"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { captionSnapshot: { title: "x".repeat(81) } }),
      ),
    (err) => expectCode(err, "BILIBILI_METADATA_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { captionSnapshot: { title: "ok", tags: ["a", 3] } })),
    (err) => expectCode(err, "BILIBILI_METADATA_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { coverUrl: "https://evil.example.com/cover.jpg" })),
    (err) => expectCode(err, "BILIBILI_COVER_URL_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { artifactSha256: "nothex" })),
    (err) => expectCode(err, "VERIFIED_ARTIFACT_REQUIRED"),
  );
});

// ---------------------------------------------------------------------------
// Platform response validation + bounded retry (429/5xx/network only)
// ---------------------------------------------------------------------------

test("HTTP errors fail closed with stable codes (401/403/4xx)", async () => {
  const media = await makeMedia("http-errors");

  const unauthorized = scriptedTransport([{ status: 401, headers: {}, body: "unauthorized" }]);
  await assert.rejects(
    () => makePublisher(unauthorized).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_AUTH_FAILED"),
  );

  const forbidden = scriptedTransport([{ status: 403, headers: {}, body: "forbidden" }]);
  await assert.rejects(
    () => makePublisher(forbidden).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_UPLOAD_FORBIDDEN"),
  );

  const rejected = scriptedTransport([{ status: 400, headers: {}, body: "bad request" }]);
  await assert.rejects(
    () => makePublisher(rejected).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_UPLOAD_REJECTED"),
  );
});

test("429 honors Retry-After and retries to success", async () => {
  const media = await makeMedia("rate-limited");
  const script = scriptedTransport([
    { status: 429, headers: { "Retry-After": "2" }, body: "slow down" },
    ...biliScript(),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(script.count, 5);
});

test("5xx and network errors retry with bounded backoff", async () => {
  const media = await makeMedia("server-error");
  const script = scriptedTransport([
    { status: 500, headers: {}, body: "boom" },
    new Error("network down"),
    ...biliScript(),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  assert.equal(script.count, 6); // 2 failed attempts + the 4 official steps
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => Number.isFinite(ms) && ms >= 0));
});

test("envelope: missing upload_token, non-zero code, and wrong shapes fail closed", async () => {
  const media = await makeMedia("envelope-guards");

  const noToken = scriptedTransport(
    biliScript().map((step, i) =>
      i === 0 ? okJson({ code: 0, data: {} }) : step,
    ),
  );
  await assert.rejects(
    () => makePublisher(noToken).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_PREPROCESS_REJECTED"),
  );

  const bizError = scriptedTransport(
    biliScript().map((step, i) =>
      i === 1 ? okJson({ code: -404, message: "part rejected" }) : step,
    ),
  );
  await assert.rejects(
    () => makePublisher(bizError).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_UPLOAD_REJECTED"),
  );

  const noArchiveId = scriptedTransport(
    biliScript({ submit: { code: 0, message: "0", data: {} } }),
  );
  await assert.rejects(
    () => makePublisher(noArchiveId).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_RECEIPT_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Official whitelist/permission codes fail closed with NO retry storm
// ---------------------------------------------------------------------------

test("official 127304 (permission not granted) fails closed and is never retried", async () => {
  const media = await makeMedia("permission");
  const script = scriptedTransport([
    okJson({ code: 127304, message: "接口访问受限" }),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => {
      expectCode(err, "BILIBILI_PERMISSION_NOT_GRANTED");
      assert.match(err.detail ?? "", /127304/);
      return true;
    },
  );
  assert.equal(script.count, 1); // no retry storm
  assert.equal(sleeps.length, 0);
});

test("official 127305 (whitelist restriction) fails closed and is never retried", async () => {
  const media = await makeMedia("whitelist");
  const script = scriptedTransport([
    okJson({ code: 127305, message: "白名单限制" }),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "BILIBILI_WHITELIST_RESTRICTED"),
  );
  assert.equal(script.count, 1);
  assert.equal(sleeps.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency: identical request replays the receipt with ZERO network use
// ---------------------------------------------------------------------------

test("idempotent replay: identical request returns duplicate receipt with no network use", async () => {
  const media = await makeMedia("replay");
  const script = scriptedTransport(biliScript());
  const { publisher } = makePublisher(script);

  const first = await publisher.publish(buildRequest(media));
  const second = await publisher.publish(buildRequest(media));

  assert.equal(script.count, 4); // still only the first publish's calls
  assert.equal(second.duplicate, true);
  assert.equal(second.platformPostId, first.platformPostId);
  assert.equal(second.submissionState, first.submissionState);

  // A different tid is a DIFFERENT publish request — no false replay; it
  // runs its own full official flow on a fresh script.
  const freshScript = scriptedTransport(biliScript());
  const different = await makePublisher(freshScript).publisher.publish(
    buildRequest(media, { tid: "21" }),
  );
  assert.equal(different.duplicate, undefined);
  assert.equal(freshScript.count, 4);
});

// ---------------------------------------------------------------------------
// Media source: path guards, before any network
// ---------------------------------------------------------------------------

test("media source: traversal, unreadable, and empty files fail closed", async () => {
  const media = await makeMedia("source-guards");
  const publisher = makePublisher(biliScript()).publisher;

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: "../escape.bin" })),
    (err) => expectCode(err, "BILIBILI_MEDIA_SOURCE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: join(mediaDir, "missing.bin") })),
    (err) => expectCode(err, "BILIBILI_MEDIA_SOURCE_UNREADABLE"),
  );

  const emptyPath = join(mediaDir, "empty.bin");
  await writeFile(emptyPath, Buffer.alloc(0));
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: emptyPath })),
    (err) => expectCode(err, "BILIBILI_MEDIA_SOURCE_UNREADABLE"),
  );
});

test("mediaResolver: takes precedence over the request field and is scoped correctly", async () => {
  const media = await makeMedia("resolver");
  const script = scriptedTransport(biliScript());
  const resolverScopes = [];
  const { publisher } = makePublisher(script, {
    mediaResolver: async (scope) => {
      resolverScopes.push(scope);
      return { filePath: media.filePath };
    },
  });

  const receipt = await publisher.publish(
    buildRequest(media, { mediaFilePath: "../should-not-be-used.bin" }),
  );
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  assert.deepEqual(resolverScopes, [
    {
      ownerId: "owner-01",
      agentId: "agent-07",
      artifactSha256: media.sha256,
      destination: "bilibili",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Signed requests: injected signer honored, secret never surfaces
// ---------------------------------------------------------------------------

test("signRequest: injected signer headers are attached to every official call", async () => {
  const media = await makeMedia("signed");
  const script = scriptedTransport(biliScript());
  const signedUrls = [];
  const { publisher, credentialsScopes } = makePublisher(script, {
    signRequest: async ({ url, headers }) => {
      signedUrls.push(url);
      assert.deepEqual(headers, {});
      return { "X-Bili-Signature": "fixture-signature", "X-Bili-Timestamp": "000" };
    },
  });

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, RESOURCE_ID);
  // Preprocess, part, merge are signed; the submission carries the Bearer
  // token (the exact signing convention is a deployment-side contract).
  assert.equal(signedUrls.length, 3);
  assert.equal(script.calls[0].headers["X-Bili-Signature"], "fixture-signature");
  assert.equal(script.calls[1].headers["X-Bili-Signature"], "fixture-signature");
  assert.equal(script.calls[2].headers["X-Bili-Signature"], "fixture-signature");
  assert.equal(credentialsScopes.length, 1);
});

// ---------------------------------------------------------------------------
// Token containment (Rule 17): credentials never surface in errors/receipts
// ---------------------------------------------------------------------------

test("rule 17: the access token never appears in thrown errors or receipts", async () => {
  const media = await makeMedia("containment");
  const script = scriptedTransport([
    okJson({ code: -101, message: "account not authorized for this app" }),
  ]);
  const { publisher } = makePublisher(script);

  let caught = null;
  try {
    await publisher.publish(buildRequest(media));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.ok(!JSON.stringify(caught).includes(TOKEN));
  assert.ok(!String(caught.stack).includes(TOKEN));
});
