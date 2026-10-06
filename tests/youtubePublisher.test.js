import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createYouTubePublisher,
  YOUTUBE_UPLOAD_SESSION_URL,
} from "../src/publishing/youtubePublisher.js";
import { PublishingService } from "../src/publishing/publishingService.js";

// Test fixture only — never a real credential (Rule 17).
const TOKEN = "test-access-token-value-123";
const LOCATION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_type=resumable&upload_id=abc";
const RAW_BODY = JSON.stringify({ id: "abc12345678", snippet: { title: "ok" } });

let mediaDir;

test.before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yt-publisher-"));
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
  const { approval, ...rest } = overrides;
  const request = {
    id: "req-1",
    ownerId: "owner-01",
    agentId: "agent-07",
    artifactSha256: media.sha256,
    destination: "youtube",
    captionSnapshot: {
      title: "Episode 1 - the build",
      description: "How the pipeline works",
      tags: ["build", "tech"],
    },
    approval: {
      ownerId: "owner-01",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      artifactSha256: media.sha256,
      destination: "youtube",
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

function okInit(headers = { Location: LOCATION }) {
  return { status: 200, headers, body: "" };
}
function okPut(body = RAW_BODY) {
  return { status: 200, headers: {}, body };
}

function makePublisher(script, extra = {}) {
  const tokens = [];
  const sleeps = [];
  const publisher = createYouTubePublisher({
    resolveAccessToken: async (scope) => {
      tokens.push(scope);
      return TOKEN;
    },
    transport: script.transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { publisher, tokens, sleeps };
}

function expectCode(error, code) {
  assert.equal(error?.code, code, `${code} expected, got ${error?.code ?? error?.message}`);
  return true;
}

// ---------------------------------------------------------------------------
// Construction / configuration fails closed
// ---------------------------------------------------------------------------

test("constructor: missing token resolver, transport, or bad retry config fails closed", () => {
  assert.throws(() => createYouTubePublisher({}), (err) => expectCode(err, "YOUTUBE_TOKEN_RESOLVER_REQUIRED"));
  assert.throws(
    () => createYouTubePublisher({ resolveAccessToken: async () => "t", transport: "nope" }),
    (err) => expectCode(err, "YOUTUBE_TRANSPORT_REQUIRED"),
  );
  assert.throws(
    () =>
      createYouTubePublisher({
        resolveAccessToken: async () => "t",
        maxAttempts: 0,
      }),
    (err) => expectCode(err, "YOUTUBE_RETRY_CONFIG_INVALID"),
  );
  assert.throws(
    () =>
      createYouTubePublisher({
        resolveAccessToken: async () => "t",
        mediaResolver: "nope",
      }),
    (err) => expectCode(err, "YOUTUBE_MEDIA_RESOLVER_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Happy path: official request shapes + honest receipt
// ---------------------------------------------------------------------------

test("publish: official resumable session + PUT produce a receipt from the real response body", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));

  assert.match(publisher.label, /youtube-upload/);
  assert.equal(receipt.platformPostId, "abc12345678");
  assert.equal(receipt.platformUrl, "https://www.youtube.com/watch?v=abc12345678");
  assert.equal(receipt.rawResponse, RAW_BODY);
  assert.equal(receipt.visibility, "private");
  assert.equal(receipt.duplicate, false);
  // No token anywhere in the serialized receipt (Rule 17).
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));

  assert.equal(script.count, 2);
  const [init, put] = script.calls;
  assert.equal(init.method, "POST");
  assert.equal(init.url, YOUTUBE_UPLOAD_SESSION_URL);
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["X-Upload-Content-Length"], String(media.size));
  const metadata = JSON.parse(init.body);
  assert.equal(metadata.snippet.title, "Episode 1 - the build");
  assert.equal(metadata.snippet.categoryId, "28");
  assert.equal(metadata.status.privacyStatus, "private");

  assert.equal(put.method, "PUT");
  assert.equal(put.url, LOCATION);
  assert.equal(put.bodyFile, media.filePath);
  assert.equal(put.headers.Authorization, `Bearer ${TOKEN}`);

  // Director-scoped token resolution (Director isolation).
  assert.deepEqual(tokens, [{ ownerId: "owner-01", agentId: "agent-07" }]);
});

test("publish: unlisted visibility is passed through; label is honest", async () => {
  const media = await makeMedia("unlisted-bytes");
  const script = scriptedTransport([okInit(), okPut(JSON.stringify({ id: "unlisted1234" }))]);
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(
    buildRequest(media, { visibility: "unlisted" }),
  );
  assert.equal(receipt.visibility, "unlisted");
  assert.equal(receipt.platformPostId, "unlisted1234");
  const metadata = JSON.parse(script.calls[0].body);
  assert.equal(metadata.status.privacyStatus, "unlisted");
});

// ---------------------------------------------------------------------------
// Private-first + metadata + Rule 15
// ---------------------------------------------------------------------------

test("publish: public visibility is refused before any token or network call", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { visibility: "public" })),
    (err) => expectCode(err, "YOUTUBE_PUBLIC_UPLOAD_FORBIDDEN"),
  );
  assert.equal(script.count, 0);
  assert.equal(tokens.length, 0);
});

test("publish: internal agent names in metadata are denied before any network call (Rule 15)", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          captionSnapshot: { title: "Created by JARVIS", description: "", tags: [] },
        }),
      ),
    (err) => expectCode(err, "AGENT_NAME_LEAKAGE_DENIED"),
  );
  assert.equal(script.count, 0);
  assert.equal(tokens.length, 0);
});

test("publish: metadata bounds fail closed", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          captionSnapshot: { title: "x".repeat(101), description: "", tags: [] },
        }),
      ),
    (err) => expectCode(err, "YOUTUBE_METADATA_INVALID"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          captionSnapshot: { title: "ok", description: "", tags: ["a".repeat(501)] },
        }),
      ),
    (err) => expectCode(err, "YOUTUBE_METADATA_INVALID"),
  );
  assert.equal(script.count, 0);
});

// ---------------------------------------------------------------------------
// Rule 7: approval binding
// ---------------------------------------------------------------------------

test("publish: missing, expired, or artifact-mismatched approval is refused", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { approval: undefined })),
    (err) => expectCode(err, "OWNER_APPROVAL_REQUIRED"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          approval: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_EXPIRED"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          approval: { artifactSha256: "a".repeat(64) },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_ARTIFACT_MISMATCH"),
  );
  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, {
          approval: { destination: "bilibili" },
        }),
      ),
    (err) => expectCode(err, "APPROVAL_DESTINATION_MISMATCH"),
  );
  assert.equal(script.count, 0);
});

test("publish: destination must be youtube", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { destination: "bilibili" })),
    (err) => expectCode(err, "YOUTUBE_DESTINATION_REQUIRED"),
  );
  assert.equal(script.count, 0);
});

// ---------------------------------------------------------------------------
// Media source + artifact binding (before any credential/network use)
// ---------------------------------------------------------------------------

test("publish: missing, unsafe, or unreadable media source fails closed before the network", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: undefined })),
    (err) => expectCode(err, "YOUTUBE_MEDIA_SOURCE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: "../escape.bin" })),
    (err) => expectCode(err, "YOUTUBE_MEDIA_SOURCE_INVALID"),
  );
  await assert.rejects(
    () => publisher.publish(buildRequest(media, { mediaFilePath: join(mediaDir, "absent.bin") })),
    (err) => expectCode(err, "YOUTUBE_MEDIA_SOURCE_UNREADABLE"),
  );
  assert.equal(script.count, 0);
  assert.equal(tokens.length, 0);
});

test("publish: file bytes must match the approved artifact hash before token resolution", async () => {
  const media = await makeMedia();
  const other = await makeMedia("different-content");
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  await assert.rejects(
    () =>
      publisher.publish(
        buildRequest(media, { artifactSha256: other.sha256, approval: { artifactSha256: other.sha256 } }),
      ),
    (err) => expectCode(err, "YOUTUBE_MEDIA_HASH_MISMATCH"),
  );
  assert.equal(script.count, 0);
  assert.equal(tokens.length, 0);
});

// ---------------------------------------------------------------------------
// Token honesty
// ---------------------------------------------------------------------------

test("publish: unavailable token fails closed with zero transport calls", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const publisher = createYouTubePublisher({
    resolveAccessToken: async () => null,
    transport: script.transport,
    sleep: async () => {},
  });

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => expectCode(err, "YOUTUBE_AUTH_TOKEN_UNAVAILABLE"),
  );
  assert.equal(script.count, 0);
});

test("publish: 401 fails closed without retry and never leaks the token", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([
    { status: 401, headers: {}, body: `{"error":"token=${TOKEN} expired"}` },
  ]);
  const { publisher } = makePublisher(script);

  await assert.rejects(
    () => publisher.publish(buildRequest(media)),
    (err) => {
      expectCode(err, "YOUTUBE_AUTH_FAILED");
      assert.ok(!String(err.detail ?? "").includes(TOKEN), "token must not appear in error detail");
      return true;
    },
  );
  assert.equal(script.count, 1, "401 is never retried");
});

test("publish: 403 fails closed without retry", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([{ status: 403, headers: {}, body: "quota exceeded" }]);
  const { publisher } = makePublisher(script);

  await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "YOUTUBE_UPLOAD_FORBIDDEN"),
  );
  assert.equal(script.count, 1, "403 is never retried");
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("publish: 429 honors Retry-After then succeeds", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([
    { status: 429, headers: { "Retry-After": "1" }, body: "slow down" },
    okInit(),
    okPut(),
  ]);
  const { publisher, sleeps } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, "abc12345678");
  assert.deepEqual(sleeps, [1000]);
  assert.equal(script.count, 3);
});

test("publish: 5xx exhausts the bounded retry budget", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([
    { status: 500, headers: {}, body: "boom" },
    { status: 503, headers: {}, body: "boom" },
  ]);
  const { publisher, sleeps } = makePublisher(script, { maxAttempts: 2 });

  await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "YOUTUBE_UPLOAD_UNAVAILABLE"),
  );
  assert.equal(script.count, 2);
  assert.deepEqual(sleeps, [200]);
});

test("publish: transport network failures are retryable and sanitized", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([new Error("socket hang up"), okInit(), okPut()]);
  const { publisher } = makePublisher(script);

  const receipt = await publisher.publish(buildRequest(media));
  assert.equal(receipt.platformPostId, "abc12345678");
  assert.equal(script.count, 3);
});

test("publish: malformed transport responses fail closed without retry", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([{ nope: true }]);
  const { publisher } = makePublisher(script);

  await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
    expectCode(err, "YOUTUBE_TRANSPORT_RESPONSE_INVALID"),
  );
  assert.equal(script.count, 1);
});

// ---------------------------------------------------------------------------
// Session Location hardening (SSRF / R3)
// ---------------------------------------------------------------------------

test("publish: session responses without a safe Google HTTPS Location are rejected", async () => {
  const media = await makeMedia();
  const cases = [
    {},
    { Location: "http://www.googleapis.com/upload" },
    { Location: "https://evil.example/upload" },
    { Location: "https://user:pass@www.googleapis.com/upload" },
    { Location: "not-a-url" },
  ];
  for (const headers of cases) {
    const script = scriptedTransport([{ status: 200, headers, body: "" }]);
    const { publisher } = makePublisher(script);
    await assert.rejects(
      () => publisher.publish(buildRequest(media)),
      (err) => expectCode(err, "YOUTUBE_UPLOAD_SESSION_REJECTED"),
      `headers ${JSON.stringify(headers)} must be rejected`,
    );
    assert.equal(script.count, 1);
  }
});

// ---------------------------------------------------------------------------
// Receipt honesty (Rule 2)
// ---------------------------------------------------------------------------

test("publish: upload responses without a usable video id never fabricate a receipt", async () => {
  const media = await makeMedia();
  for (const body of ["not-json", "{}", JSON.stringify({ id: "bad id!" })]) {
    const script = scriptedTransport([okInit(), okPut(body)]);
    const { publisher } = makePublisher(script);
    await assert.rejects(() => publisher.publish(buildRequest(media)), (err) =>
      expectCode(err, "YOUTUBE_UPLOAD_RECEIPT_INVALID"),
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotency + Director isolation
// ---------------------------------------------------------------------------

test("publish: an identical repeat replays the stored receipt with zero network calls", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut()]);
  const { publisher, tokens } = makePublisher(script);

  const first = await publisher.publish(buildRequest(media));
  const second = await publisher.publish(buildRequest(media));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.platformPostId, first.platformPostId);
  assert.equal(script.count, 2, "replay must not touch the network");
  assert.equal(tokens.length, 1, "replay must not re-resolve the token");
});

test("publish: idempotency is Director-scoped — another Director uploads independently", async () => {
  const media = await makeMedia();
  const script = scriptedTransport([okInit(), okPut(), okInit(), okPut(JSON.stringify({ id: "other99999" }))]);
  const { publisher, tokens } = makePublisher(script);

  await publisher.publish(buildRequest(media));
  const other = await publisher.publish(buildRequest(media, { agentId: "agent-08" }));

  assert.equal(other.platformPostId, "other99999");
  assert.equal(other.duplicate, false);
  assert.equal(script.count, 4);
  assert.deepEqual(tokens, [
    { ownerId: "owner-01", agentId: "agent-07" },
    { ownerId: "owner-01", agentId: "agent-08" },
  ]);
});

// ---------------------------------------------------------------------------
// Contract compatibility: PublishingService dispatch end-to-end (mock transport)
// ---------------------------------------------------------------------------

test("publish: satisfies PublishingService.dispatch end-to-end with an honest receipt hash", async () => {
  const media = await makeMedia("service-integration-bytes");
  const script = scriptedTransport([okInit(), okPut()]);
  const publisher = createYouTubePublisher({
    resolveAccessToken: async () => TOKEN,
    transport: script.transport,
    sleep: async () => {},
    mediaResolver: async () => ({ filePath: media.filePath }),
  });

  const service = new PublishingService();
  const identity = {
    agentId: "agent-01",
    agent: { id: "agent-01", name: "InternalAgentName" },
    profile: {
      agentId: "agent-01",
      publicBrandName: "Public Studio Brand",
      publicDisplayName: "Studio Brand",
      status: "active",
    },
  };
  const request = service.request({
    ...identity,
    artifactSha256: media.sha256,
    destination: "youtube",
    captionSnapshot: { title: "Verified build log" },
    mode: "private",
  });
  service.approve(request.id, {
    ownerId: "owner-01",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    artifactSha256: media.sha256,
    destination: "youtube",
  });

  const result = await service.dispatch(request.id, publisher, { dryRun: false });

  assert.equal(result.status, "platform_verified");
  assert.equal(result.published, true);
  assert.equal(result.platformPostId, "abc12345678");
  assert.equal(
    result.providerResponseSha256,
    createHash("sha256").update(RAW_BODY).digest("hex"),
  );
  assert.equal(script.count, 2);
});
