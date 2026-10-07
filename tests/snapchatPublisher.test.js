import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapchatPublisher,
  SNAP_API_BASE,
  SNAP_SPOTLIGHT_URL_BASE,
} from "../src/publishing/snapchatPublisher.js";

// Test fixture only — never a real credential (Rule 17).
const TOKEN = "test-access-token-value-123";
// Official docs example UUIDs — fixtures, not real profiles.
const PROFILE_ID = "62d2298b-925b-4953-9cb0-b3a492d51d0c";
const MEDIA_ID = "abed133c-0b1b-3676-8808-3dd6cc164909";
const ADD_PATH = `/us/v1/public_profiles/${PROFILE_ID}/media/${MEDIA_ID}/multipart-upload`;
const SPOTLIGHT_ID = "W7_EDlXWTBiXAEEniNoMPwAAYaWd5d21yeG92AX_7pp00AX_7ppwFAAAAAA";

let mediaDir;

test.before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "snap-publisher-"));
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
    destination: "snapchat",
    captionSnapshot: captionSnapshot ?? {
      title: "Episode 1 - the build",
      description: "How the pipeline works",
    },
    approval: {
      ownerId: "owner-01",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      artifactSha256: media.sha256,
      destination: "snapchat",
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

const SNAP_CREDENTIALS = { accessToken: TOKEN, profileId: PROFILE_ID };

const CREATE_MEDIA_RESPONSE = {
  request_id: "ecfe244d-0b1b-4787-9919-4ee7dd275a0a",
  request_status: "SUCCESS",
  media_id: MEDIA_ID,
  add_path: ADD_PATH,
  finalize_path: ADD_PATH,
};
const OK_UPLOAD = {
  request_id: "47ed85dd-0ca7-449e-94a0-d48486fcc56e",
  request_status: "SUCCESS",
};
const OK_SPOTLIGHT = {
  request_id: "5007083c-cef7-4638-bea7-1b8a6d5b7281",
  spotlight_id: SPOTLIGHT_ID,
  request_status: "SUCCESS",
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
  return {
    transport,
    calls,
    get count() {
      return index;
    },
  };
}

function okJson(body, headers = {}) {
  return { status: 200, headers, body: JSON.stringify(body) };
}

/**
 * Official 4-step script: create media → N ADD chunks → FINALIZE → spotlight.
 * `parts` must match the number of 32 MB chunks the media will produce.
 */
function snapScript({ parts = 1, spotlight = OK_SPOTLIGHT, media = CREATE_MEDIA_RESPONSE } = {}) {
  return [
    okJson(media),
    ...Array.from({ length: parts }, () => okJson(OK_UPLOAD)),
    okJson(OK_UPLOAD),
    okJson(spotlight),
  ];
}

function makePublisher(script, extra = {}) {
  const credentialsScopes = [];
  const sleeps = [];
  const publisher = createSnapchatPublisher({
    resolveCredentials: async (scope) => {
      credentialsScopes.push(scope);
      return SNAP_CREDENTIALS;
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

/** Parse a scripted multipart body against its boundary header. */
function multipartAssertions(call) {
  const contentType = call.headers["Content-Type"];
  assert.match(contentType, /^multipart\/form-data; boundary=[0-9a-f]{32}$/);
  const boundary = contentType.split("boundary=")[1];
  const body = Buffer.isBuffer(call.body) ? call.body.toString("latin1") : String(call.body);
  return {
    boundary,
    body,
    hasField: (name, value) =>
      body.includes(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    hasFilePart: body.includes('Content-Disposition: form-data; name="file"'),
    isTerminated: body.includes(`--${boundary}--`),
  };
}

// ---------------------------------------------------------------------------
// Construction / configuration fails closed
// ---------------------------------------------------------------------------

test("constructor: missing resolver, transport, bad retry config, or bad locale fails closed", () => {
  assert.throws(() => createSnapchatPublisher({}), (err) =>
    expectCode(err, "SNAP_CREDENTIAL_RESOLVER_REQUIRED"));
  assert.throws(
    () => createSnapchatPublisher({ resolveCredentials: async () => SNAP_CREDENTIALS, transport: "nope" }),
    (err) => expectCode(err, "SNAP_TRANSPORT_REQUIRED"),
  );
  assert.throws(
    () => createSnapchatPublisher({ resolveCredentials: async () => SNAP_CREDENTIALS, maxAttempts: 0 }),
    (err) => expectCode(err, "SNAP_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createSnapchatPublisher({ resolveCredentials: async () => SNAP_CREDENTIALS, maxAttempts: 6 }),
    (err) => expectCode(err, "SNAP_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () => createSnapchatPublisher({ resolveCredentials: async () => SNAP_CREDENTIALS, mediaResolver: "nope" }),
    (err) => expectCode(err, "SNAP_MEDIA_RESOLVER_INVALID"),
  );
  assert.throws(
    () => createSnapchatPublisher({ resolveCredentials: async () => SNAP_CREDENTIALS, defaultLocale: "en" }),
    (err) => expectCode(err, "SNAP_LOCALE_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Happy path: official request shapes + honest receipt
// ---------------------------------------------------------------------------

test("publish: official create-media → ADD → FINALIZE → spotlight with a real spotlight_id receipt", async () => {
  const media = await makeMedia();
  const script = scriptedTransport(snapScript());
  const { publisher, credentialsScopes } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));

  // Credential scope is director-bound and destination-bound.
  assert.deepEqual(credentialsScopes, [
    { ownerId: "owner-01", agentId: "agent-07", destination: "snapchat" },
  ]);

  // Step 1: official create-media call with base64 key/iv protocol fields.
  const create = script.calls[0];
  assert.equal(create.url, `${SNAP_API_BASE}/v1/public_profiles/${PROFILE_ID}/media`);
  assert.equal(create.method, "POST");
  assert.equal(create.headers.Authorization, `Bearer ${TOKEN}`);
  const createBody = JSON.parse(create.body);
  assert.equal(createBody.type, "VIDEO");
  assert.equal(typeof createBody.name, "string");
  assert.match(createBody.name, /^stph-[0-9a-f]{16}$/);
  assert.equal(Buffer.from(createBody.key, "base64").length, 32);
  assert.equal(Buffer.from(createBody.iv, "base64").length, 16);

  // Step 2: official ADD multipart with the encrypted chunk.
  const add = script.calls[1];
  assert.equal(add.url, `${SNAP_API_BASE}${ADD_PATH}`);
  const addMultipart = multipartAssertions(add);
  assert.ok(addMultipart.hasField("action", "ADD"));
  assert.ok(addMultipart.hasField("part_number", "1"));
  assert.ok(addMultipart.hasFilePart);
  assert.ok(addMultipart.isTerminated);
  // The uploaded bytes are ENCRYPTED — never the plaintext artifact.
  assert.ok(!addMultipart.body.includes("fake-video-bytes-for-tests"));

  // Step 3: official FINALIZE multipart.
  const finalize = script.calls[2];
  assert.equal(finalize.url, `${SNAP_API_BASE}${ADD_PATH}`);
  const finalizeMultipart = multipartAssertions(finalize);
  assert.ok(finalizeMultipart.hasField("action", "FINALIZE"));

  // Step 4: official spotlight post with description + locale.
  const post = script.calls[3];
  assert.equal(post.url, `${SNAP_API_BASE}/v1/public_profiles/${PROFILE_ID}/spotlights`);
  const postBody = JSON.parse(post.body);
  assert.equal(postBody.media_id, MEDIA_ID);
  assert.equal(postBody.description, "Episode 1 - the build\nHow the pipeline works");
  assert.equal(postBody.locale, "en_US");

  // Honest receipt: REAL spotlight_id + canonical URL from the pinned base.
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
  assert.equal(receipt.platformUrl, `${SNAP_SPOTLIGHT_URL_BASE}${SPOTLIGHT_ID}`);
  assert.equal(typeof receipt.rawResponse, "string");
  assert.deepEqual(JSON.parse(receipt.rawResponse), OK_SPOTLIGHT);
  // Token containment (Rule 17): the receipt never carries the credential.
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
});

test("publish: captionSnapshot.caption takes precedence and locale override is honored", async () => {
  const media = await makeMedia("caption-precedence");
  const script = scriptedTransport(snapScript());
  const { publisher } = makePublisher(script);

  await publisher.publish(
    buildRequest(media, {
      captionSnapshot: {
        title: "ignored-long-title-because-caption-present",
        description: "also ignored",
        caption: "Short #caption",
        locale: "en-IN",
      },
    }),
  );

  const postBody = JSON.parse(script.calls[3].body);
  assert.equal(postBody.description, "Short #caption");
  assert.equal(postBody.locale, "en_IN");
});

test("publish: 33MB media splits into two ≤32MB encrypted parts with official part_number sequence", async () => {
  const bigContent = Buffer.alloc(33 * 1024 * 1024, 7);
  const media = await makeMedia(bigContent);
  const script = scriptedTransport(snapScript({ parts: 2 }));
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));

  // create → ADD part 1 → ADD part 2 → FINALIZE → spotlight.
  assert.equal(script.count, 5);
  const part1 = multipartAssertions(script.calls[1]);
  const part2 = multipartAssertions(script.calls[2]);
  assert.ok(part1.hasField("part_number", "1"));
  assert.ok(part2.hasField("part_number", "2"));
  // Each uploaded chunk respects the official ≤32 MB constraint.
  const chunkSize = (call) => {
    const boundary = call.headers["Content-Type"].split("boundary=")[1];
    const marker = Buffer.from(`\r\n--${boundary}\r\n`);
    const start = call.body.indexOf(marker, call.body.indexOf(Buffer.from(`name="file"`)));
    return start - (call.body.indexOf(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`)) + 39);
  };
  assert.ok(chunkSize(script.calls[1]) <= 32 * 1024 * 1024);
  assert.ok(chunkSize(script.calls[2]) <= 32 * 1024 * 1024);
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
});

// ---------------------------------------------------------------------------
// Rule 7: approval binding inside the adapter (defense-in-depth)
// ---------------------------------------------------------------------------

test("approval: expired, artifact-mismatched, destination-mismatched, or owner-mismatched fails closed", async () => {
  const media = await makeMedia("approval-binding");
  const expired = makePublisher(snapScript()).publisher;
  await assert.rejects(
    () =>
      expired.publish(
        buildRequest(media, {
          approval: { expiresAt: new Date(Date.now() - 1000).toISOString() },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_EXPIRED"),
  );

  const mismatched = makePublisher(snapScript()).publisher;
  await assert.rejects(
    () =>
      mismatched.publish(
        buildRequest(media, {
          approval: { artifactSha256: "a".repeat(64) },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );

  const wrongDestination = makePublisher(snapScript()).publisher;
  await assert.rejects(
    () =>
      wrongDestination.publish(
        buildRequest(media, { approval: { destination: "youtube" } }),
      ),
    (err) => expectCode(err, "APPROVAL_DESTINATION_MISMATCH"),
  );

  const wrongOwner = makePublisher(snapScript()).publisher;
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
  const script = scriptedTransport(snapScript());
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { captionSnapshot: { caption: "brought to you by JARVIS" } }),
      ),
    (err) => expectCode(err, "AGENT_NAME_LEAKAGE_DENIED"),
  );
  assert.equal(script.count, 0);
});

test("artifact binding: substituted file bytes fail before credential resolution", async () => {
  const media = await makeMedia("real-bytes");
  const script = scriptedTransport(snapScript());
  const { publisher, credentialsScopes } = makePublisher(script);
  const other = await makeMedia("substituted-bytes");

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: other.filePath })),
    (err) => expectCode(err, "SNAP_MEDIA_HASH_MISMATCH"),
  );
  assert.equal(script.count, 0);
  assert.equal(credentialsScopes.length, 0);
});

test("request validation: destination, metadata, and locale fail closed", async () => {
  const media = await makeMedia("validation");
  const publisher = makePublisher(snapScript()).publisher;

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { destination: "youtube" })),
    (err) => expectCode(err, "SNAP_DESTINATION_REQUIRED"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { captionSnapshot: { caption: "x".repeat(161) } }),
      ),
    (err) => expectCode(err, "SNAP_DESCRIPTION_TOO_LONG"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { captionSnapshot: { caption: "   " } })),
    (err) => expectCode(err, "SNAP_METADATA_INVALID"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { captionSnapshot: { caption: "ok", locale: "nope" } }),
      ),
    (err) => expectCode(err, "SNAP_LOCALE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { artifactSha256: "nothex" })),
    (err) => expectCode(err, "VERIFIED_ARTIFACT_REQUIRED"),
  );
});

// ---------------------------------------------------------------------------
// Platform response validation + bounded retry (429/5xx/network only)
// ---------------------------------------------------------------------------

test("create-media: HTTP errors fail closed with stable codes (401/403/4xx)", async () => {
  const media = await makeMedia("create-errors");

  const unauthorized = scriptedTransport([{ status: 401, headers: {}, body: "unauthorized" }]);
  await assert.rejects(
    () => makePublisher(unauthorized).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_AUTH_FAILED"),
  );

  const forbidden = scriptedTransport([{ status: 403, headers: {}, body: "forbidden" }]);
  await assert.rejects(
    () => makePublisher(forbidden).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_UPLOAD_FORBIDDEN"),
  );

  const rejected = scriptedTransport([{ status: 400, headers: {}, body: "bad request" }]);
  await assert.rejects(
    () => makePublisher(rejected).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_UPLOAD_REJECTED"),
  );
});

test("create-media: 429 honors Retry-After and retries to success", async () => {
  const media = await makeMedia("rate-limited");
  const script = scriptedTransport([
    { status: 429, headers: { "Retry-After": "2" }, body: "slow down" },
    ...snapScript(),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(script.count, 5);
});

test("create-media: 5xx and network errors retry with bounded backoff", async () => {
  const media = await makeMedia("server-error");
  const script = scriptedTransport([
    { status: 500, headers: {}, body: "boom" },
    new Error("network down"),
    ...snapScript(),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
  // 2 failed attempts + the 4 official steps of the successful attempt.
  assert.equal(script.count, 6);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => Number.isFinite(ms) && ms >= 0));
});

test("create-media: missing media_id or unsafe paths fail closed", async () => {
  const media = await makeMedia("bad-container");

  const noId = scriptedTransport(
    snapScript({ media: { ...CREATE_MEDIA_RESPONSE, media_id: undefined } }),
  );
  await assert.rejects(
    () => makePublisher(noId).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_MEDIA_CONTAINER_REJECTED"),
  );

  // An absolute URL in add_path is an SSRF attempt — rejected, never followed.
  const absolutePath = scriptedTransport(
    snapScript({
      media: {
        ...CREATE_MEDIA_RESPONSE,
        add_path: "https://evil.example.com/upload",
      },
    }),
  );
  await assert.rejects(
    () => makePublisher(absolutePath).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_MEDIA_CONTAINER_REJECTED"),
  );

  const traversalPath = scriptedTransport(
    snapScript({ media: { ...CREATE_MEDIA_RESPONSE, finalize_path: "/us/../admin/v1/x" } }),
  );
  await assert.rejects(
    () => makePublisher(traversalPath).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_MEDIA_CONTAINER_REJECTED"),
  );
});

test("upload/finalize: ERROR request_status and network failures surface stable codes", async () => {
  const media = await makeMedia("add-error");

  const addError = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson({ request_id: "x", request_status: "ERROR", error_code: "CHUNK_REJECTED" }),
  ]);
  await assert.rejects(
    () => makePublisher(addError).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_UPLOAD_REJECTED"),
  );

  const finalizeError = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson(OK_UPLOAD),
    okJson({ request_id: "y", request_status: "ERROR", error_code: "NOT_COMPLETE" }),
  ]);
  await assert.rejects(
    () => makePublisher(finalizeError).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_UPLOAD_REJECTED"),
  );

  const networkThenOk = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    new Error("connection reset"),
    okJson(OK_UPLOAD),
    okJson(OK_UPLOAD),
    okJson(OK_SPOTLIGHT),
  ]);
  const receipt = await makePublisher(networkThenOk).publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
});

// ---------------------------------------------------------------------------
// Spotlight post: official logical errors fail closed, receipts stay honest
// ---------------------------------------------------------------------------

test("spotlight post: MEDIA_EXPIRED fails closed and is never retried", async () => {
  const media = await makeMedia("expired-media");
  const script = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson(OK_UPLOAD),
    okJson(OK_UPLOAD),
    okJson({
      request_id: "5007083c-cef7-4638-bea7-1b8a6d5b7281",
      request_status: "ERROR",
      error_code: "MEDIA_EXPIRED",
    }),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_MEDIA_EXPIRED"),
  );
  // Exactly the 4 official calls — no automatic re-create (which could
  // double-publish); sleeps empty proves no retry happened.
  assert.equal(script.count, 4);
  assert.equal(sleeps.length, 0);
});

test("spotlight post: MEDIA_POSTING_ALREADY_IN_PROGRESS fails closed, never retried", async () => {
  const media = await makeMedia("in-progress");
  const script = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson(OK_UPLOAD),
    okJson(OK_UPLOAD),
    okJson({
      request_id: "5007083c-cef7-4638-bea7-1b8a6d5b7281",
      request_status: "ERROR",
      error_code: "MEDIA_POSTING_ALREADY_IN_PROGRESS",
    }),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_MEDIA_POSTING_IN_PROGRESS"),
  );
  assert.equal(script.count, 4);
  assert.equal(sleeps.length, 0);
});

test("spotlight post: other official error codes fail closed as SNAP_SPOTLIGHT_REJECTED", async () => {
  const media = await makeMedia("rejected");
  const script = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson(OK_UPLOAD),
    okJson(OK_UPLOAD),
    okJson({ request_status: "ERROR", error_code: "SOMETHING_ELSE" }),
  ]);
  await assert.rejects(
    () => makePublisher(script).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_SPOTLIGHT_REJECTED"),
  );
});

test("receipt: missing or wrong-shape spotlight_id is SNAP_RECEIPT_INVALID, never fabricated", async () => {
  const media = await makeMedia("no-id");

  const missing = scriptedTransport(
    snapScript({ spotlight: { request_id: "r1", request_status: "SUCCESS" } }),
  );
  await assert.rejects(
    () => makePublisher(missing).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_RECEIPT_INVALID"),
  );

  const malformed = scriptedTransport(
    snapScript({ spotlight: { ...OK_SPOTLIGHT, spotlight_id: "short" } }),
  );
  await assert.rejects(
    () => makePublisher(malformed).publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "SNAP_RECEIPT_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Idempotency: identical request replays the receipt with ZERO network calls
// ---------------------------------------------------------------------------

test("idempotent replay: identical request returns duplicate receipt with no network use", async () => {
  const media = await makeMedia("replay");
  const script = scriptedTransport(snapScript());
  const { publisher } = makePublisher(script);

  const first = await publisher.publish(buildRequest(media));
  const second = await publisher.publish(buildRequest(media));

  assert.equal(script.count, 4); // still only the first publish's calls
  assert.equal(second.duplicate, true);
  assert.equal(second.platformPostId, first.platformPostId);
  assert.equal(second.platformUrl, first.platformUrl);

  // A changed description is a DIFFERENT publish request — no false replay;
  // it runs its own full official flow on a fresh script.
  const freshScript = scriptedTransport(snapScript());
  const different = await makePublisher(freshScript).publisher.publish(
    buildRequest(media, { captionSnapshot: { caption: "a different spotlight" } }),
  );
  assert.equal(different.duplicate, undefined);
  assert.equal(freshScript.count, 4);
});

// ---------------------------------------------------------------------------
// Media source: path guards and the official 1 GB limit, before any network
// ---------------------------------------------------------------------------

test("media source: traversal, unreadable, and oversized files fail closed", async () => {
  const media = await makeMedia("source-guards");
  const publisher = makePublisher(snapScript()).publisher;

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: "../escape.bin" })),
    (err) => expectCode(err, "SNAP_MEDIA_SOURCE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: join(mediaDir, "missing.bin") })),
    (err) => expectCode(err, "SNAP_MEDIA_SOURCE_UNREADABLE"),
  );

  // Sparse file just over the official 1 GB limit — no bytes actually written.
  const sparsePath = join(mediaDir, "oversize.bin");
  const handle = await open(sparsePath, "w");
  await handle.truncate(1024 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: sparsePath })),
    (err) => expectCode(err, "SNAP_MEDIA_TOO_LARGE"),
  );
});

test("mediaResolver: takes precedence over the request field and is scoped correctly", async () => {
  const media = await makeMedia("resolver");
  const script = scriptedTransport(snapScript());
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
  assert.equal(receipt.platformPostId, SPOTLIGHT_ID);
  assert.deepEqual(resolverScopes, [
    {
      ownerId: "owner-01",
      agentId: "agent-07",
      artifactSha256: media.sha256,
      destination: "snapchat",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Token containment (Rule 17): credentials never surface in errors/receipts
// ---------------------------------------------------------------------------

test("rule 17: the access token never appears in thrown errors or receipts", async () => {
  const media = await makeMedia("containment");
  const script = scriptedTransport([
    okJson(CREATE_MEDIA_RESPONSE),
    okJson(OK_UPLOAD),
    okJson(OK_UPLOAD),
    okJson({ request_status: "ERROR", error_code: "REJECTED_DEBUG", debug_message: "details here" }),
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
