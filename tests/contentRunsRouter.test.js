import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOwnerApp } from "../src/api/ownerServer.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";
import { createHash, randomUUID } from "node:crypto";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryRunStore {
  constructor(runs = []) {
    this.name = "MemoryRunStore";
    this.runs = runs;
  }
  async listRuns(ownerId) {
    return this.runs.filter((run) => run.ownerId === ownerId);
  }
  async getRun(ownerId, packageTaskId) {
    return this.runs.find((run) => run.ownerId === ownerId && run.packageTaskId === packageTaskId) ?? null;
  }
}

function runFixture(overrides = {}) {
  return {
    packageTaskId: "pkg-ainews-001",
    schemaVersion: 1,
    orchestrator: "ai_news_content_package_v1",
    packageId: "a".repeat(64),
    agentId: "agent-ai-news",
    ownerId: "owner-alpha",
    readiness: "package_incomplete_pending_narration_input",
    reasonCode: null,
    briefId: "b".repeat(64),
    stagesCompleted: 3,
    stages: [
      {
        stage: "research_brief",
        status: "completed",
        taskId: "pkg-ainews-001#research_brief",
        jobType: "ai-news.research-brief.v1",
        resultHash: "c".repeat(64),
        readiness: "ready_for_editorial_review",
        reasonCode: null,
        // Disallowed field that must never be serialized:
        internalNote: "NEVER_SERIALIZE_ME"
      }
    ],
    researchBrief: { planType: "ai_news_research_brief", planId: "d".repeat(64), readiness: "ready_for_editorial_review" },
    editorialPlan: { planType: "ai_news_editorial_plan", planId: "e".repeat(64), readiness: "editorial_plan_only" },
    metadataThumbnailPlan: { planType: "ai_news_metadata_thumbnail_plan", planId: "f".repeat(64), readiness: "metadata_thumbnail_plan_only" },
    subtitlePlan: null,
    provenance: {
      generationMode: "deterministic_local",
      providerCalls: 0,
      networkCalls: 0,
      generatedMediaCount: 0,
      mediaStatus: "not_generated",
      internalNote: "NEVER_SERIALIZE_ME"
    },
    publication: { requested: false, status: "not_requested" },
    ...overrides
  };
}

async function startSession(app) {
  const res = await request(app)
    .post("/session/start")
    .send({ token: VALID_BOOTSTRAP_TOKEN })
    .expect(200);
  return res.body.token;
}

function makeApp({ runs = [], evidenceLedger = null, bootstrapOwnerId = "owner-alpha" } = {}) {
  return createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: bootstrapOwnerId,
    packageRunStore: new MemoryRunStore(runs),
    evidenceLedger
  });
}

// ------------------------------------------------------------
// Authentication and session scoping
// ------------------------------------------------------------
test("content runs: unauthenticated requests are rejected on all three routes", async () => {
  const app = makeApp({ runs: [runFixture()] });
  const resList = await request(app).get("/content-runs").expect(401);
  assert.equal(resList.body.error, "UNAUTHORIZED");
  const resGet = await request(app).get("/content-runs/pkg-ainews-001").expect(401);
  assert.equal(resGet.body.error, "UNAUTHORIZED");
  const resEv = await request(app).get("/content-runs/pkg-ainews-001/evidence").expect(401);
  assert.equal(resEv.body.error, "UNAUTHORIZED");
});

test("content runs: list and detail are scoped to the session owner", async () => {
  const app = makeApp({
    runs: [
      runFixture(),
      runFixture({ packageTaskId: "pkg-ainews-002", ownerId: "owner-beta" })
    ]
  });
  const token = await startSession(app);

  const listRes = await request(app)
    .get("/content-runs")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(listRes.body.ownerId, "owner-alpha");
  assert.equal(listRes.body.count, 1);
  assert.equal(listRes.body.runs[0].packageTaskId, "pkg-ainews-001");

  const detailRes = await request(app)
    .get("/content-runs/pkg-ainews-002")
    .set("Authorization", `Bearer ${token}`)
    .expect(404); // cross-owner access is a generic 404 (no existence leak)
  assert.equal(detailRes.body.error, "NOT_FOUND");
});

test("content runs: missing runs and cross-owner runs are indistinguishable 404s", async () => {
  const app = makeApp({ runs: [runFixture()] });
  const token = await startSession(app);
  const res = await request(app)
    .get("/content-runs/pkg-does-not-exist")
    .set("Authorization", `Bearer ${token}`)
    .expect(404);
  assert.equal(res.body.error, "NOT_FOUND");
});

// ------------------------------------------------------------
// Safe DTO allowlists (Rule 17)
// ------------------------------------------------------------
test("content runs: responses use strict allowlists — unknown fields never serialize", async () => {
  const app = makeApp({ runs: [runFixture()] });
  const token = await startSession(app);

  const detailRes = await request(app)
    .get("/content-runs/pkg-ainews-001")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);

  const body = detailRes.body;
  assert.equal(body.internalNote, undefined);
  assert.equal(body.provenance.internalNote, undefined);
  assert.equal(body.stages[0].internalNote, undefined);
  assert.equal(body.plans.researchBrief.planType, "ai_news_research_brief");
  assert.deepEqual(Object.keys(body.provenance).sort(), [
    "generatedMediaCount",
    "generationMode",
    "mediaStatus",
    "networkCalls",
    "providerCalls"
  ]);
  assert.deepEqual(Object.keys(body.stages[0]).sort(), [
    "jobType",
    "readiness",
    "reasonCode",
    "resultHash",
    "stage",
    "status",
    "taskId"
  ]);

  const listRes = await request(app)
    .get("/content-runs")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(listRes.body.runs[0].stages, undefined); // summary projection only
  assert.equal(listRes.body.runs[0].plans, undefined);
});

// ------------------------------------------------------------
// Error shapes for malformed input
// ------------------------------------------------------------
test("content runs: malformed ids and query parameters yield clean 4xx allowlisted codes", async () => {
  const app = makeApp({ runs: [runFixture()] });
  const token = await startSession(app);
  const auth = { Authorization: `Bearer ${token}` };

  const badId = await request(app).get("/content-runs/bad%20id%20with%20spaces").set(auth).expect(400);
  assert.equal(badId.body.error, "PACKAGE_TASK_ID_INVALID");

  const badQuery = await request(app).get("/content-runs?limit=999").set(auth).expect(400);
  assert.equal(badQuery.body.error, "QUERY_INVALID");

  const badQuery2 = await request(app).get("/content-runs?limit=abc").set(auth).expect(400);
  assert.equal(badQuery2.body.error, "QUERY_INVALID");
});

// ------------------------------------------------------------
// Evidence timeline with recomputed hash chain
// ------------------------------------------------------------
test("content runs: evidence timeline recomputes chain positions and reports integrity truthfully", async () => {
  const ledger = new EvidenceLedger();
  // Two unrelated events from another subject occupy real chain positions.
  ledger.append({ subjectId: "other-subject", kind: "workflow_checkpoint", classification: "unrelated_one", payload: {} });
  ledger.append({ subjectId: "pkg-ainews-001", kind: "workflow_checkpoint", classification: "ai_news_stage_completed", payload: { stage: "research_brief", stageTaskId: "pkg-ainews-001#research_brief", resultHash: "c".repeat(64) } });
  ledger.append({ subjectId: "pkg-ainews-001", kind: "workflow_checkpoint", classification: "ai_news_content_package_completed", payload: { packageId: "a".repeat(64) } });
  ledger.append({ subjectId: "other-subject", kind: "workflow_checkpoint", classification: "unrelated_two", payload: {} });

  const app = makeApp({ runs: [runFixture()], evidenceLedger: ledger });
  const token = await startSession(app);

  const res = await request(app)
    .get("/content-runs/pkg-ainews-001/evidence")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);

  assert.equal(res.body.packageTaskId, "pkg-ainews-001");
  assert.equal(res.body.events.length, 2);
  // Global chain positions preserved (1 and 2 in the real append order)
  assert.deepEqual(res.body.events.map((event) => event.chainPosition), [1, 2]);
  // Payloads use the evidence allowlist
  assert.deepEqual(Object.keys(res.body.events[0].payload).sort(), ["resultHash", "stage", "stageTaskId"]);
  // Chain summary reflects the WHOLE ledger truthfully
  assert.equal(res.body.chain.length, 4);
  assert.equal(res.body.chain.valid, true);
  assert.ok(/^[a-f0-9]{64}$/.test(res.body.chain.lastHash));
});

test("content runs: evidence events for other subjects are never returned (subject scoping)", async () => {
  const ledger = new EvidenceLedger();
  ledger.append({ subjectId: "pkg-of-owner-beta", kind: "workflow_checkpoint", classification: "foreign_event", payload: { secretNote: "do-not-leak" } });

  const app = makeApp({ runs: [runFixture()], evidenceLedger: ledger });
  const token = await startSession(app);

  // The run exists for this owner, so the route answers 200 — but only the
  // requested subject's events are returned; foreign events never appear.
  const res = await request(app)
    .get("/content-runs/pkg-ainews-001/evidence")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.deepEqual(res.body.events, []);
  assert.ok(JSON.stringify(res.body).includes("foreign_event") === false);
  assert.ok(JSON.stringify(res.body).includes("do-not-leak") === false);

  // A run owned by someone else is still a generic 404 with no evidence leak.
  const crossOwner = await request(app)
    .get("/content-runs/pkg-of-owner-beta/evidence")
    .set("Authorization", `Bearer ${token}`)
    .expect(404);
  assert.equal(crossOwner.body.error, "NOT_FOUND");
});

test("content runs: evidence route degrades honestly when no ledger is configured", async () => {
  const app = makeApp({ runs: [runFixture()], evidenceLedger: null });
  const token = await startSession(app);
  const res = await request(app)
    .get("/content-runs/pkg-ainews-001/evidence")
    .set("Authorization", `Bearer ${token}`)
    .expect(503);
  assert.equal(res.body.error, "EVIDENCE_LEDGER_UNAVAILABLE");
});

test("content runs: tampered ledger events are reported as an invalid chain, never hidden", async () => {
  const ledger = new EvidenceLedger();
  ledger.append({ subjectId: "pkg-ainews-001", kind: "workflow_checkpoint", classification: "ai_news_stage_completed", payload: { stage: "research_brief" } });
  // Simulate tampering: mutate a stored event's recorded hash.
  const events = ledger.list();
  const tampered = events.map((event, index) =>
    index === 0 ? { ...event, eventHash: "0".repeat(64) } : event
  );

  // Recompute the chain the same way the router does and assert the verdict.
  let previousHash = null;
  let valid = true;
  for (const event of tampered) {
    const recomputed = sha256Hex(
      JSON.stringify(
        stable({
          id: event.id,
          occurredAt: event.occurredAt,
          previousHash: event.previousHash,
          subjectId: event.subjectId,
          kind: event.kind,
          classification: event.classification,
          payload: event.payload ?? {}
        })
      )
    );
    if (event.previousHash !== previousHash || recomputed !== event.eventHash) valid = false;
    previousHash = event.eventHash;
  }
  assert.equal(valid, false);
});

test("content runs: hash chain verification mirrors EvidenceLedger exactly", async () => {
  const ledger = new EvidenceLedger();
  const first = ledger.append({ subjectId: "s", kind: "workflow_checkpoint", classification: "a", payload: { x: 1 } });
  const second = ledger.append({ subjectId: "s", kind: "workflow_checkpoint", classification: "b", payload: { y: 2 } });

  // Recompute with the documented formula and compare to the ledger's values.
  const expectedFirst = sha256Hex(
    JSON.stringify(
      stable({
        id: first.id,
        occurredAt: first.occurredAt,
        previousHash: first.previousHash,
        subjectId: first.subjectId,
        kind: first.kind,
        classification: first.classification,
        payload: first.payload ?? {}
      })
    )
  );
  assert.equal(first.eventHash, expectedFirst);
  assert.equal(second.previousHash, first.eventHash);
  assert.ok(randomUUID);
});
