import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIssuePayload,
  classifyExistingIssueForRelabel,
  planPromotions,
  validateManifest
} from "../src/automation/backlogFeeder.js";

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    manifestType: "st_backlog_manifest",
    description: "Test manifest",
    limits: { maxPerLanePerRun: 1, maxTotalPerRun: 3, maxOpenReadyIssues: 6 },
    slices: [
      {
        sliceId: "S-TEST-01",
        module: 1,
        lane: "lane-1",
        ownerGated: false,
        title: "First test slice",
        brief: "A brief",
        acceptance: ["Criterion one", "Criterion two"],
        dependsOn: []
      },
      {
        sliceId: "S-TEST-02",
        module: 2,
        lane: "lane-2",
        ownerGated: false,
        title: "Second test slice",
        brief: "Another brief",
        acceptance: ["Criterion A"],
        dependsOn: ["S-TEST-01"]
      },
      {
        sliceId: "S-TEST-03",
        module: 3,
        lane: "lane-3",
        ownerGated: false,
        title: "Third test slice",
        brief: "Third brief",
        acceptance: ["Criterion X"],
        dependsOn: []
      },
      {
        sliceId: "S-TEST-04",
        module: 4,
        lane: "lane-1",
        ownerGated: true,
        title: "Owner gated slice",
        brief: "Requires the owner",
        acceptance: ["Owner does it"]
      }
    ],
    ...overrides
  };
}

const emptyState = { openReadyIssuesByLane: { "lane-1": 0, "lane-2": 0, "lane-3": 0 } };

// ------------------------------------------------------------
// Manifest validation
// ------------------------------------------------------------
test("manifest: valid manifest passes validation unchanged", () => {
  const value = manifest();
  assert.deepEqual(validateManifest(value), value);
});

test("manifest: schema, type, and limits fail closed", () => {
  assert.throws(() => validateManifest(null), /BACKLOG_MANIFEST_INVALID/);
  assert.throws(() => validateManifest(manifest({ schemaVersion: 2 })), /BACKLOG_MANIFEST_SCHEMA_UNSUPPORTED/);
  assert.throws(() => validateManifest(manifest({ manifestType: "other" })), /BACKLOG_MANIFEST_TYPE_MISMATCH/);
  assert.throws(
    () => validateManifest(manifest({ limits: { maxPerLanePerRun: 0, maxTotalPerRun: 3, maxOpenReadyIssues: 6 } })),
    /BACKLOG_MANIFEST_LIMITS_INVALID/
  );
  assert.throws(() => validateManifest(manifest({ slices: [] })), /BACKLOG_MANIFEST_SLICES_INVALID/);
});

test("manifest: slice field violations fail closed with stable codes", () => {
  assert.throws(() => validateManifest(manifest({ slices: [{ ...manifest().slices[0], sliceId: "bad id" }] })), /BACKLOG_SLICE_ID_INVALID/);
  assert.throws(
    () => validateManifest(manifest({ slices: [manifest().slices[0], manifest().slices[0]] })),
    /BACKLOG_SLICE_DUPLICATE/
  );
  assert.throws(() => validateManifest(manifest({ slices: [{ ...manifest().slices[0], lane: "lane-9" }] })), /BACKLOG_SLICE_LANE_INVALID/);
  assert.throws(() => validateManifest(manifest({ slices: [{ ...manifest().slices[0], ownerGated: "yes" }] })), /BACKLOG_SLICE_OWNER_GATED_INVALID/);
  assert.throws(() => validateManifest(manifest({ slices: [{ ...manifest().slices[0], title: "" }] })), /BACKLOG_SLICE_TITLE_INVALID/);
  assert.throws(() => validateManifest(manifest({ slices: [{ ...manifest().slices[0], acceptance: [] }] })), /BACKLOG_SLICE_ACCEPTANCE_INVALID/);
});

test("manifest: dependency integrity fails closed on forward refs and self deps", () => {
  const forward = manifest();
  forward.slices[0].dependsOn = ["S-TEST-02"]; // declared later => forward reference
  assert.throws(() => validateManifest(forward), /BACKLOG_SLICE_DEPENDS_FORWARD_REFERENCE/);

  const self = manifest();
  self.slices[0].dependsOn = ["S-TEST-01"];
  assert.throws(() => validateManifest(self), /BACKLOG_SLICE_DEPENDS_SELF/);
});

// ------------------------------------------------------------
// Promotion planning
// ------------------------------------------------------------
test("plan: independent ready slices are promotable; owner-gated never are", () => {
  const plan = planPromotions(manifest(), emptyState);
  assert.deepEqual(plan.promotable, ["S-TEST-01", "S-TEST-03"]);
  assert.deepEqual(plan.ownerGated, ["S-TEST-04"]);
});

test("plan: dependencies gate dependents until the dependency is promoted", () => {
  const plan = planPromotions(manifest(), {
    openReadyIssuesByLane: { "lane-1": 0, "lane-2": 0, "lane-3": 0 },
    promotedSliceIds: ["S-TEST-01"]
  });
  assert.deepEqual(plan.promotable, ["S-TEST-02", "S-TEST-03"]);
});

test("plan: lane concurrency caps per lane and total open ready issues", () => {
  const busyLane = planPromotions(manifest(), {
    openReadyIssuesByLane: { "lane-1": 1, "lane-2": 0, "lane-3": 0 }
  });
  const busyPlan = busyLane.skipped.find((entry) => entry.sliceId === "S-TEST-01");
  assert.equal(busyPlan.reason, "LANE_BUSY");

  const capped = planPromotions(
    manifest({ limits: { maxPerLanePerRun: 1, maxTotalPerRun: 3, maxOpenReadyIssues: 1 } }),
    emptyState
  );
  assert.equal(capped.promotable.length, 1);
  assert.ok(capped.skipped.every((entry) => entry.reason === "OPEN_READY_LIMIT" || entry.reason === "DEPENDENCY_UNSATISFIED" || capped.promotable.includes(entry.sliceId) === false));
});

test("plan: already-promoted slices are skipped with a deterministic reason", () => {
  const plan = planPromotions(manifest(), {
    openReadyIssuesByLane: { "lane-1": 0, "lane-2": 0, "lane-3": 0 },
    promotedSliceIds: ["S-TEST-01", "S-TEST-03"]
  });
  assert.deepEqual(plan.promotable, ["S-TEST-02"]);
  assert.ok(plan.skipped.some((entry) => entry.sliceId === "S-TEST-01" && entry.reason === "ALREADY_PROMOTED"));
});

test("plan: state validation fails closed", () => {
  assert.throws(() => planPromotions(manifest(), null), /BACKLOG_STATE_INVALID/);
  assert.throws(
    () => planPromotions(manifest(), { openReadyIssuesByLane: { "lane-9": 1 } }),
    /BACKLOG_STATE_LANE_COUNT_INVALID/
  );
  assert.throws(
    () => planPromotions(manifest(), { openReadyIssuesByLane: { "lane-1": -1 } }),
    /BACKLOG_STATE_LANE_COUNT_INVALID/
  );
  assert.throws(
    () => planPromotions(manifest(), { openReadyIssuesByLane: {}, existingSliceIssues: "nope" }),
    /BACKLOG_STATE_EXISTING_INVALID/
  );
  assert.throws(
    () => planPromotions(manifest(), { openReadyIssuesByLane: {}, promotedSliceIds: [42] }),
    /BACKLOG_STATE_PROMOTED_INVALID/
  );
});

test("plan: deterministic across repeated evaluations", () => {
  const args = [manifest(), { openReadyIssuesByLane: { "lane-1": 0, "lane-2": 0, "lane-3": 0 }, promotedSliceIds: ["S-TEST-01"] }];
  const expected = planPromotions(...args);
  for (let index = 0; index < 50; index += 1) {
    assert.deepEqual(planPromotions(...args), expected);
  }
});

// ------------------------------------------------------------
// Issue payload construction
// ------------------------------------------------------------
test("payload: title carries the slice tag and body carries governance contract", () => {
  const payload = buildIssuePayload(manifest(), "S-TEST-01", ["jarvis", "sherlock"]);
  assert.equal(payload.title, "[S-TEST-01] First test slice");
  assert.ok(payload.body.includes("**Module**: 1"));
  assert.ok(payload.body.includes("**Depends on**: none"));
  assert.ok(payload.body.includes("Closes #<issue>"));
  assert.deepEqual(payload.labels, ["lane-1", "ready"]);
});

test("payload: unknown slice and owner-gated slices fail closed", () => {
  assert.throws(() => buildIssuePayload(manifest(), "S-NOPE-99", []), /BACKLOG_SLICE_NOT_FOUND/);
  assert.throws(() => buildIssuePayload(manifest(), "S-TEST-04", []), /BACKLOG_SLICE_OWNER_GATED/);
});

test("payload: internal agent names in promotable text are rejected (Rule 15)", () => {
  const leaky = manifest();
  leaky.slices[0].title = "Wire the jarvis dispatcher";
  assert.throws(() => buildIssuePayload(leaky, "S-TEST-01", ["jarvis"]), /BACKLOG_SLICE_INTERNAL_NAME_REJECTED/);
});

// ------------------------------------------------------------
// Existing-issue relabel classification (issue #137)
// ------------------------------------------------------------
test("relabel: stale unready issue is returned to the ready queue with missing labels", () => {
  const slice = manifest().slices[0];
  const decision = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["lane-1"],
    referencedByOpenPr: false
  });
  assert.equal(decision.action, "RELABEL_READY");
  assert.equal(decision.reason, "STALE_READY_STATE");
  assert.deepEqual(decision.addLabels, ["ready"]);
});

test("relabel: issue missing both ready and its lane gets both applied", () => {
  const slice = manifest().slices[0];
  const decision = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: [],
    referencedByOpenPr: false
  });
  assert.equal(decision.action, "RELABEL_READY");
  assert.deepEqual(decision.addLabels, ["ready", "lane-1"]);
});

test("relabel: already-ready issue is left alone", () => {
  const slice = manifest().slices[0];
  const decision = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["ready", "lane-1"],
    referencedByOpenPr: false
  });
  assert.equal(decision.action, "NONE");
  assert.equal(decision.reason, "ALREADY_READY");
});

test("relabel: in-progress and blocked issues are never touched", () => {
  const slice = manifest().slices[0];
  const inProgress = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["in-progress"],
    referencedByOpenPr: false
  });
  assert.equal(inProgress.action, "NONE");
  assert.equal(inProgress.reason, "IN_PROGRESS");

  const blocked = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["blocked"],
    referencedByOpenPr: false
  });
  assert.equal(blocked.action, "NONE");
  assert.equal(blocked.reason, "BLOCKED");
});

test("relabel: open PR referencing the slice blocks relabel (one canonical PR per slice)", () => {
  const slice = manifest().slices[0];
  const decision = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["lane-1"],
    referencedByOpenPr: true
  });
  assert.equal(decision.action, "NONE");
  assert.equal(decision.reason, "OPEN_PR_REFERENCES_SLICE");
});

test("relabel: closed issues and owner-gated slices are never relabeled", () => {
  const slice = manifest().slices[0];
  const closed = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "closed",
    labels: [],
    referencedByOpenPr: false
  });
  assert.equal(closed.action, "NONE");
  assert.equal(closed.reason, "ISSUE_CLOSED");

  const gated = manifest().slices[3]; // S-TEST-04, ownerGated
  const decision = classifyExistingIssueForRelabel(gated, {
    number: 132,
    state: "open",
    labels: [],
    referencedByOpenPr: false
  });
  assert.equal(decision.action, "NONE");
  assert.equal(decision.reason, "OWNER_GATED");
});

test("relabel: absent PR observation is fail-open to stale-state relabel, malformed input fails closed", () => {
  const slice = manifest().slices[0];
  const withoutObservation = classifyExistingIssueForRelabel(slice, {
    number: 132,
    state: "open",
    labels: ["lane-1"]
  });
  assert.equal(withoutObservation.action, "RELABEL_READY");

  assert.throws(
    () => classifyExistingIssueForRelabel(slice, { number: 0, state: "open", labels: [] }),
    /BACKLOG_ISSUE_NUMBER_INVALID/
  );
  assert.throws(
    () => classifyExistingIssueForRelabel(slice, { number: 132, state: "reopened", labels: [] }),
    /BACKLOG_ISSUE_STATE_INVALID/
  );
  assert.throws(
    () => classifyExistingIssueForRelabel(slice, { number: 132, state: "open", labels: [42] }),
    /BACKLOG_ISSUE_LABELS_INVALID/
  );
  assert.throws(
    () => classifyExistingIssueForRelabel(slice, { number: 132, state: "open", labels: [], referencedByOpenPr: "no" }),
    /BACKLOG_ISSUE_OBSERVATION_INVALID/
  );
});
