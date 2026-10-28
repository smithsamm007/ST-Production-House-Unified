/**
 * Cross-platform publishing DRY-RUN end-to-end validation (S-M38-01).
 *
 * Drives the REAL owner publish boundary (POST /ops/publishing/:agentId/
 * private-test) in destination-router mode across youtube, instagram,
 * facebook, and snapchat, with scripted per-destination recording publishers.
 * Fully offline: no network call, no real platform upload, no live account —
 * every "receipt" is a fixed scripted response and is only ever recorded as
 * a private-first DRY-RUN test receipt. Live publishing remains owner-gated
 * (Issue #118; AGENTS.md Rule 7).
 *
 * Proven here (beyond the existing single-publisher route and unit tests):
 *   - exact dispatch: a destination reaches ONLY its own wired publisher;
 *   - per-destination receipts, audit rows, and evidence-ledger entries;
 *   - allowlisted DTOs per destination (public attribution, never tokens);
 *   - a supported-but-unwired destination degrades honestly (503) while other
 *     destinations keep working on the SAME deployment;
 *   - a failing destination publisher yields a truthful non-2xx with NO
 *     fabricated platform id/url (Rules 1 and 2);
 *   - transport selection is server-side only: a request-supplied publisher
 *     is structurally rejected in router mode too;
 *   - draft and private modes both record their mode honestly per destination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOwnerApp } from "../src/api/ownerServer.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes
const VALID_ARTIFACT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AGENT_ID = "agent-01";
const DESTINATIONS = Object.freeze(["youtube", "instagram", "facebook", "snapchat"]);

const RECEIPT_SHAPES = Object.freeze({
  youtube: { postId: "yt_e2e_1001", url: "https://www.youtube.com/watch?v=yt_e2e_1001" },
  instagram: { postId: "ig_e2e_media_1001", url: "https://www.instagram.com/reel/ig_e2e_media_1001/" },
  facebook: { postId: "fb_e2e_video_1001", url: "https://www.facebook.com/watch/?v=fb_e2e_video_1001" },
  snapchat: { postId: "spotlight_e2e_1001", url: "https://www.snapchat.com/spotlight/spotlight_e2e_1001" },
});

/** Minimal durable audit surface (same contract the demo adapter satisfies). */
class AuditOnlyDb {
  constructor() {
    this.name = "AuditOnlyDb";
    this.auditRows = [];
  }
  async query(text, params) {
    if (text.startsWith("INSERT INTO owner_control_audit")) {
      this.auditRows.push({
        ownerId: params[0],
        agentId: params[1],
        action: params[2],
        detail: JSON.parse(params[3]),
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`MEMORY_DB_UNEXPECTED_QUERY: ${text.slice(0, 40)}`);
  }
}

/**
 * Scripted per-destination publisher: records every dispatch request and
 * returns only its own receipt shape. No network, no real platform id.
 */
function makeRecordingPublisher(destination, { fail = false } = {}) {
  const state = { destination, calls: [], publish: null };
  state.publish = async (request) => {
    state.calls.push(request);
    if (fail) {
      const error = new Error("PUBLISHING_PLATFORM_UNREACHABLE");
      throw error;
    }
    const receipt = RECEIPT_SHAPES[destination];
    return {
      platformPostId: receipt.postId,
      platformUrl: receipt.url,
      rawResponse: JSON.stringify({ privacyStatus: "private", id: receipt.postId, destination }),
    };
  };
  return state;
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

function buildApp(overrides = {}) {
  const evidenceLedger = overrides.evidenceLedger ?? new EvidenceLedger();
  const db = overrides.db ?? new AuditOnlyDb();
  const app = createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: "owner-alpha",
    evidenceLedger,
    dbAdapter: db,
    resolvePublishingIdentity: async ({ agentId, destination }) => {
      assert.ok(DESTINATIONS.includes(destination), `identity resolved only for governed destinations: ${destination}`);
      return publishingIdentity(agentId);
    },
    ...overrides,
  });
  return { app, evidenceLedger, db };
}

async function createSession(app) {
  const res = await request(app)
    .post("/session/start")
    .send({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  assert.equal(res.status, 200);
  return { token: res.body.token, csrfToken: res.body.csrfToken };
}

function publishRequest(app, { headers, destination, mode, publisher, captionText = "Private-first E2E preview" }) {
  const body = {
    artifactSha256: VALID_ARTIFACT_HASH,
    destination,
    captionSnapshot: { text: captionText },
    mode,
  };
  if (publisher !== undefined) body.publisher = publisher;
  return request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set(headers)
    .send(body);
}

// ---------------------------------------------------------------------------
// Full-matrix dry-run: every wired destination dispatches to its own publisher
// ---------------------------------------------------------------------------

test("dry-run E2E: each wired destination dispatches ONLY to its own publisher with honest receipts", async () => {
  const publishers = Object.fromEntries(DESTINATIONS.map((d) => [d, makeRecordingPublisher(d)]));
  const { app, db, evidenceLedger } = buildApp({ publishersByDestination: publishers });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  for (const destination of DESTINATIONS) {
    const res = await publishRequest(app, { headers, destination, mode: "private" });
    assert.equal(res.status, 200, `${destination} must publish successfully`);
    const body = res.body.publishingTest;
    const receipt = RECEIPT_SHAPES[destination];

    // The receipt comes from THAT destination's publisher only.
    assert.equal(body.status, "platform_verified");
    assert.equal(body.published, true);
    assert.equal(body.mode, "private");
    assert.equal(body.destination, destination);
    assert.equal(body.platformPostId, receipt.postId);
    assert.equal(body.platformUrl, receipt.url);
    assert.equal(body.publicAttribution, "Public Studio Brand");

    // Allowlisted DTO: never serializes approval internals or credentials.
    assert.deepEqual(Object.keys(body).sort(), [
      "agentId", "destination", "mode", "platformPostId", "platformUrl",
      "providerResponseSha256", "publicAttribution", "published", "requestId", "status", "testId",
    ]);
  }

  // Exact dispatch: each publisher saw exactly one call, for its own
  // destination, carrying the artifact hash and the private mode.
  for (const destination of DESTINATIONS) {
    const state = publishers[destination];
    assert.equal(state.calls.length, 1, `${destination} publisher invoked exactly once`);
    const dispatched = state.calls[0];
    assert.equal(dispatched.destination, destination);
    assert.equal(dispatched.mode, "private");
    assert.equal(dispatched.artifactSha256, VALID_ARTIFACT_HASH);
    assert.ok(dispatched.attributionSnapshot, "attribution snapshot bound to the request");
  }

  // Rule 6: one audit row per successful destination, each scoped to the owner.
  assert.equal(db.auditRows.length, DESTINATIONS.length);
  const actions = new Set(db.auditRows.map((row) => row.action));
  assert.deepEqual([...actions], ["private_publishing_test"]);
  const auditedDestinations = new Set(db.auditRows.map((row) => row.detail.destination));
  assert.equal(auditedDestinations.size, DESTINATIONS.length);
  assert.ok([...auditedDestinations].every((d) => DESTINATIONS.includes(d)));

  // Evidence ledger: one platform_publish entry per destination, private-first.
  const kinds = evidenceLedger.list().map((entry) => entry.kind);
  assert.equal(kinds.filter((k) => k === "platform_publish").length, DESTINATIONS.length);
  assert.ok(kinds.includes("owner_private_publishing_test"));
  const publishEntries = evidenceLedger.list().filter((e) => e.kind === "platform_publish");
  const entryDestinations = new Set(publishEntries.map((e) => e.payload.destination));
  assert.equal(entryDestinations.size, DESTINATIONS.length);
  for (const entry of publishEntries) {
    assert.equal(entry.classification, "private_first");
    assert.equal(entry.payload.mode, "private");
    assert.ok(!JSON.stringify(entry.payload).includes("Bearer"), "no credential material in evidence");
  }
});

test("dry-run E2E: a supported-but-unwired destination degrades honestly (503) while wired destinations keep working", async () => {
  // snapchat is NOT in the deployment registry: it must 503, never fall
  // through to another platform's publisher.
  const publishers = {
    youtube: makeRecordingPublisher("youtube"),
    instagram: makeRecordingPublisher("instagram"),
    facebook: makeRecordingPublisher("facebook"),
  };
  const { app, db, evidenceLedger } = buildApp({ publishersByDestination: publishers });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const blocked = await publishRequest(app, { headers, destination: "snapchat", mode: "private" });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, "PUBLISHING_TRANSPORT_UNAVAILABLE");
  for (const destination of Object.keys(publishers)) {
    assert.equal(publishers[destination].calls.length, 0, "no publisher is borrowed for another destination");
  }
  assert.equal(db.auditRows.length, 0, "no audit success recorded for an unavailable transport");
  assert.ok(!evidenceLedger.list().some((e) => e.kind === "platform_publish"));

  // The same deployment still serves its wired destinations exactly.
  const ok = await publishRequest(app, { headers, destination: "youtube", mode: "private" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.publishingTest.platformPostId, RECEIPT_SHAPES.youtube.postId);
  assert.equal(publishers.youtube.calls.length, 1);
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0].detail.destination, "youtube");
});

test("dry-run E2E: a failing destination publisher fails truthfully — no fabricated receipt, no platform_publish evidence", async () => {
  const publishers = {
    youtube: makeRecordingPublisher("youtube", { fail: true }),
    instagram: makeRecordingPublisher("instagram"),
  };
  const { app, db, evidenceLedger } = buildApp({ publishersByDestination: publishers });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const res = await publishRequest(app, { headers, destination: "youtube", mode: "private" });
  assert.ok(res.status >= 400, "a dead platform transport is never reported as success");
  const bodyBlob = JSON.stringify(res.body ?? {});
  assert.ok(!bodyBlob.includes("platform_verified"), "no fabricated verified status");
  assert.ok(!bodyBlob.includes(RECEIPT_SHAPES.youtube.postId), "no invented platform id");
  assert.ok(!bodyBlob.includes(RECEIPT_SHAPES.youtube.url), "no invented platform url");
  assert.ok(
    !evidenceLedger.list().some((e) => e.kind === "platform_publish"),
    "an unverifiable outcome is never written as platform evidence (Rule 1)",
  );
  assert.equal(publishers.youtube.calls.length, 1, "the failure reached the publisher — an attempt really was made");

  // A healthy destination is unaffected in the same session.
  const ok = await publishRequest(app, { headers, destination: "instagram", mode: "private" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.publishingTest.platformPostId, RECEIPT_SHAPES.instagram.postId);
});

test("dry-run E2E: draft mode records its mode honestly per destination (never claims public publishing)", async () => {
  const publishers = Object.fromEntries(DESTINATIONS.map((d) => [d, makeRecordingPublisher(d)]));
  const { app, db, evidenceLedger } = buildApp({ publishersByDestination: publishers });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  for (const destination of DESTINATIONS) {
    const res = await publishRequest(app, { headers, destination, mode: "draft" });
    assert.equal(res.status, 200, `${destination} must accept draft mode`);
    assert.equal(res.body.publishingTest.mode, "draft");
    assert.equal(res.body.publishingTest.published, true, "the receipt is real but the action is the private/draft test");
  }

  for (const row of db.auditRows) {
    assert.equal(row.detail.mode, "draft");
  }
  const entries = evidenceLedger.list().filter((e) => e.kind === "platform_publish");
  assert.equal(entries.length, DESTINATIONS.length);
  assert.ok(entries.every((e) => e.payload.mode === "draft" && e.classification === "private_first"));
});

test("dry-run E2E: transport selection stays server-side — a request-supplied publisher is rejected in router mode", async () => {
  const publishers = { youtube: makeRecordingPublisher("youtube") };
  const { app, db } = buildApp({ publishersByDestination: publishers });
  const { token, csrfToken } = await createSession(app);
  const res = await publishRequest(app, {
    headers: { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken },
    destination: "youtube",
    mode: "private",
    publisher: { publish: async () => ({ platformPostId: "client-fabricated" }) },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "CLIENT_TRANSPORT_FORBIDDEN");
  assert.equal(publishers.youtube.calls.length, 0, "the client transport never reached any publisher");
  assert.equal(db.auditRows.length, 0);
});
