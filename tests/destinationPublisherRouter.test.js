import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createDestinationPublisherRouter } from "../src/publishing/destinationPublisherRouter.js";
import { createOwnerApp } from "../src/api/ownerServer.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes
const VALID_ARTIFACT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AGENT_ID = "agent-01";

function expectCode(error, code) {
  assert.equal(error?.code, code, `${code} expected, got ${error?.code ?? error?.message}`);
  return true;
}

function fakePublisher(tag) {
  return {
    publish: async () => ({
      platformPostId: `${tag}_id_1`,
      platformUrl: `https://example.invalid/${tag}`,
      rawResponse: JSON.stringify({ tag }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Construction fails closed
// ---------------------------------------------------------------------------

test("constructor: non-object options or registry fails closed", () => {
  assert.throws(() => createDestinationPublisherRouter("nope"), (e) => expectCode(e, "DESTINATION_PUBLISHER_REGISTRY_INVALID"));
  assert.throws(() => createDestinationPublisherRouter({ publishers: ["youtube"] }), (e) => expectCode(e, "DESTINATION_PUBLISHER_REGISTRY_INVALID"));
});

test("constructor: registry entry without a publish function fails closed", () => {
  assert.throws(
    () => createDestinationPublisherRouter({ publishers: { youtube: { nope: true } } }),
    (e) => expectCode(e, "DESTINATION_PUBLISHER_INVALID"),
  );
  assert.throws(
    () => createDestinationPublisherRouter({ publishers: { snapchat: null } }),
    (e) => expectCode(e, "DESTINATION_PUBLISHER_INVALID"),
  );
});

test("constructor: unsupported destination key fails closed (never dispatched)", () => {
  assert.throws(
    () => createDestinationPublisherRouter({ publishers: { bilibili: fakePublisher("bili") } }),
    (e) => expectCode(e, "DESTINATION_PUBLISHER_UNKNOWN_DESTINATION"),
  );
});

// ---------------------------------------------------------------------------
// Exact per-destination selection
// ---------------------------------------------------------------------------

test("resolvePublisher returns exactly the publisher wired for the destination", () => {
  const yt = fakePublisher("yt");
  const snap = fakePublisher("snap");
  const ig = fakePublisher("ig");
  const fb = fakePublisher("fb");
  const router = createDestinationPublisherRouter({
    publishers: { youtube: yt, snapchat: snap, instagram: ig, facebook: fb },
  });

  assert.equal(router.resolvePublisher("youtube"), yt);
  assert.equal(router.resolvePublisher("snapchat"), snap);
  assert.equal(router.resolvePublisher("instagram"), ig);
  assert.equal(router.resolvePublisher("facebook"), fb);
});

test("resolvePublisher fails closed for unknown, unwired, or non-string destinations", () => {
  const router = createDestinationPublisherRouter({
    publishers: { youtube: fakePublisher("yt") },
  });

  // Supported but not wired: never falls through to another platform.
  assert.throws(() => router.resolvePublisher("snapchat"), (e) => expectCode(e, "PUBLISHER_NOT_WIRED_FOR_DESTINATION"));
  // Unknown destination entirely.
  assert.throws(() => router.resolvePublisher("myspace"), (e) => expectCode(e, "PUBLISHER_NOT_WIRED_FOR_DESTINATION"));
  // Non-string input.
  assert.throws(() => router.resolvePublisher(42), (e) => expectCode(e, "PUBLISHER_NOT_WIRED_FOR_DESTINATION"));
});

test("hasPublisher and destinations are deterministic and honest", () => {
  const router = createDestinationPublisherRouter({
    publishers: { snapchat: fakePublisher("snap"), facebook: fakePublisher("fb") },
  });
  assert.equal(router.hasPublisher("snapchat"), true);
  assert.equal(router.hasPublisher("youtube"), false);
  assert.equal(router.hasPublisher("myspace"), false);
  assert.deepEqual(router.destinations(), ["facebook", "snapchat"]);
});

test("bilibili is NOT a supported destination until an official adapter exists (Issue #225)", () => {
  // The canonical long-form secondary destination (S-M23-01) is documented
  // as research-complete but publish-blocked (owner-gated whitelist access).
  // It must NOT enter the supported set without a real adapter: the registry
  // rejects the unknown key at CONSTRUCTION time (fail-closed), and neither
  // hasPublisher nor resolvePublisher can ever dispatch to bilibili.
  assert.throws(
    () => createDestinationPublisherRouter({ publishers: { bilibili: fakePublisher("bili") } }),
    (e) => expectCode(e, "DESTINATION_PUBLISHER_UNKNOWN_DESTINATION"),
  );
  const router = createDestinationPublisherRouter({
    publishers: { youtube: fakePublisher("yt") },
  });
  assert.equal(router.hasPublisher("bilibili"), false);
  assert.throws(
    () => router.resolvePublisher("bilibili"),
    (e) => expectCode(e, "PUBLISHER_NOT_WIRED_FOR_DESTINATION"),
  );
});

// ---------------------------------------------------------------------------
// Owner route wiring (POST /ops/publishing/:agentId/private-test)
// ---------------------------------------------------------------------------

class MemoryOpsDb {
  constructor() {
    this.name = "MemoryOpsDb";
    this.auditRows = [];
  }
  async query(text, params) {
    if (text.startsWith("INSERT INTO owner_control_audit")) {
      this.auditRows.push({ ownerId: params[0], agentId: params[1], action: params[2] });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
}

function publishingIdentity(agentId = AGENT_ID) {
  return {
    agentId,
    agent: { id: agentId, name: "InternalNameNeverPublic" },
    profile: {
      agentId,
      publicBrandName: "Public Studio Brand",
      publicDisplayName: "Studio Brand",
      status: "active",
    },
    primarySocialAccount: null,
  };
}

async function createSession(app) {
  const res = await request(app)
    .post("/session/start")
    .send({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  assert.equal(res.status, 200);
  return { token: res.body.token, csrfToken: res.body.csrfToken };
}

function buildApp(overrides = {}) {
  const evidenceLedger = overrides.evidenceLedger ?? new EvidenceLedger();
  const app = createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: "owner-alpha",
    evidenceLedger,
    dbAdapter: new MemoryOpsDb(),
    ...overrides,
  });
  return { app, evidenceLedger };
}

async function postPrivateTest(app, destination) {
  const { token, csrfToken } = await createSession(app);
  return request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination,
      captionSnapshot: { text: "Private-first test Reel" },
    });
}

test("route: destination-aware registry dispatches through the EXACT per-destination publisher", async () => {
  let legacyCalls = 0;
  const legacyPublisher = {
    publish: async () => {
      legacyCalls += 1;
      return { platformPostId: "yt_wrong_platform", platformUrl: "https://youtube.com/watch?v=x", rawResponse: "{}" };
    },
  };
  const snapPublisher = fakePublisher("snap");
  const { app } = buildApp({
    publishingPublisher: legacyPublisher,
    publishersByDestination: { snapchat: snapPublisher },
    resolvePublishingIdentity: async () => publishingIdentity(),
  });

  const res = await postPrivateTest(app, "snapchat");
  assert.equal(res.status, 200);
  assert.equal(res.body.publishingTest.platformPostId, "snap_id_1");
  // The legacy single publisher must never receive a snapchat dispatch.
  assert.equal(legacyCalls, 0);
});

test("route: supported-but-unwired destination fails closed with 503 (never a wrong platform)", async () => {
  const { app } = buildApp({
    publishersByDestination: { snapchat: fakePublisher("snap") },
    resolvePublishingIdentity: async () => publishingIdentity(),
  });

  const res = await postPrivateTest(app, "youtube");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "PUBLISHING_TRANSPORT_UNAVAILABLE");
});

test("route: legacy single-publisher mode is preserved when no registry is wired", async () => {
  const { app } = buildApp({
    publishingPublisher: fakePublisher("yt"),
    resolvePublishingIdentity: async () => publishingIdentity(),
  });

  const res = await postPrivateTest(app, "youtube");
  assert.equal(res.status, 200);
  assert.equal(res.body.publishingTest.platformPostId, "yt_id_1");
});

test("route: no transport at all still fails closed with 503", async () => {
  const { app } = buildApp({
    resolvePublishingIdentity: async () => publishingIdentity(),
  });

  const res = await postPrivateTest(app, "youtube");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "PUBLISHING_TRANSPORT_UNAVAILABLE");
});
