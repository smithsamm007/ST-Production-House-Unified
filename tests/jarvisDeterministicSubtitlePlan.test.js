import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicSubtitlePlan,
  deterministicSubtitlePlanHandler,
} from "../src/jarvis/deterministicSubtitlePlan.js";

function sampleNarrationPackage(overrides = {}) {
  return {
    packageId: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
    sourceHash: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
    ownerId: "owner-123",
    agentId: "agent-01",
    language: "hinglish",
    narrationSegments: [
      {
        segmentId: "seg-1",
        speaker: "narrator",
        text: "Raat ke dark sannate mein ek mysterious light dekhi gayi.",
        startTime: 0.0,
        endTime: 5.5,
      },
      {
        segmentId: "seg-2",
        speaker: "narrator",
        text: "Yeh sthanik purani haveli ka sabse purana kamra tha.",
        startTime: 5.5,
        endTime: 12.0,
      },
      {
        segmentId: "seg-3",
        speaker: "narrator",
        text: "Darwaza khulte hi ek ajeeb sa saaya saamne aaya.",
        startTime: 12.0,
        endTime: 18.0,
      },
    ],
    ...overrides,
  };
}

test("creates deterministic subtitle plan with stable packageId and ordering", () => {
  const source = sampleNarrationPackage();
  const plan1 = createDeterministicSubtitlePlan(source);
  const plan2 = createDeterministicSubtitlePlan(source);

  assert.deepEqual(plan1, plan2);
  assert.equal(plan1.readiness, "subtitle_plan_only");
  assert.equal(plan1.generationMode, "deterministic_local");
  assert.equal(plan1.ownerId, "owner-123");
  assert.equal(plan1.agentId, "agent-01");
  assert.equal(plan1.longFormPlan.aspectRatio, "16:9");
  assert.equal(plan1.longFormPlan.width, 1920);
  assert.equal(plan1.longFormPlan.height, 1080);
  assert.ok(plan1.longFormPlan.cues.length >= 3);
  assert.deepEqual(plan1.generatedMedia, []);
  assert.deepEqual(plan1.providerCalls, []);
  assert.deepEqual(plan1.artifacts, []);
  assert.equal(plan1.publication.status, "not_requested");
});

test("preserves Hindi Devanagari Unicode and Hinglish without transliteration changes", () => {
  const source = sampleNarrationPackage({
    language: "hindi",
    narrationSegments: [
      {
        segmentId: "seg-hindi-1",
        speaker: "narrator",
        text: "रात के अंधेरे में हवेली की घंटी अपने आप बजने लगी।",
        startTime: 0.0,
        endTime: 6.0,
      },
      {
        segmentId: "seg-hindi-2",
        speaker: "narrator",
        text: "कोई भी दरवाज़ा खोलने की हिम्मत नहीं कर सका।",
        startTime: 6.0,
        endTime: 12.0,
      },
    ],
  });

  const plan = createDeterministicSubtitlePlan(source);
  assert.equal(plan.language, "hindi");
  const firstCue = plan.longFormPlan.cues[0];
  assert.ok(firstCue.text.includes("रात के अंधेरे में"));
  assert.ok(firstCue.srtFormatted.includes("00:00:00,000 -->"));
  assert.ok(firstCue.vttFormatted.includes("00:00:00.000 -->"));
});

test("splits oversized cues at safe word boundaries within length limits", () => {
  const longText = "Yeh ek bahot hi lambi kahani ka hissa hai jismein har ek lafz ko sahi boundary par split karna zaroori hai subtle plan ke liye.";
  const source = sampleNarrationPackage({
    narrationSegments: [
      {
        segmentId: "seg-long",
        speaker: "narrator",
        text: longText,
        startTime: 0.0,
        endTime: 20.0,
      },
    ],
  });

  const plan = createDeterministicSubtitlePlan(source);
  for (const cue of plan.longFormPlan.cues) {
    assert.ok(cue.text.length <= 42, `Cue length ${cue.text.length} exceeds 42 limit: "${cue.text}"`);
    assert.ok(cue.durationSeconds <= 7.0, `Cue duration ${cue.durationSeconds} exceeds 7s limit`);
    assert.ok(cue.endTime > cue.startTime, "Cue end time must be after start time");
  }
});

test("enforces timing boundaries, overlap rejection, and non-negative/NaN checks", () => {
  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Invalid start time.", startTime: -1.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_TIMING_NEGATIVE_OR_NAN/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "NaN end time.", startTime: 0.0, endTime: NaN },
      ],
    })),
    /SUBTITLE_TIMING_NEGATIVE_OR_NAN/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "First segment.", startTime: 0.0, endTime: 6.0 },
        { segmentId: "s2", text: "Overlapping segment.", startTime: 4.5, endTime: 10.0 },
      ],
    })),
    /SUBTITLE_TIMING_OVERLAP_DETECTED/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Excessive duration.", startTime: 0.0, endTime: 1900.0 },
      ],
    })),
    /SUBTITLE_DURATION_EXCESSIVE/
  );
});

test("rejects hostile markup, secret-like strings, and internal agent name leaks", () => {
  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Dangerous <script>alert('xss')</script> tag", startTime: 0.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_MARKUP_UNSUPPORTED/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Contains secret vault://secret-locator-12345", startTime: 0.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_SECRET_REJECTED/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Contains secret api_key=supersecretkeyvalue", startTime: 0.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_SECRET_REJECTED/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Narrated by JARVIS internal agent name", startTime: 0.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_INTERNAL_AGENT_NAME_REJECTED/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({
      narrationSegments: [
        { segmentId: "s1", text: "Mentions SHERLOCK agent name", startTime: 0.0, endTime: 5.0 },
      ],
    })),
    /SUBTITLE_INTERNAL_AGENT_NAME_REJECTED/
  );
});

test("enforces strict scope isolation for ownerId and agentId", () => {
  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage({ ownerId: "" })),
    /SUBTITLE_SCOPE_INVALID_OWNER/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage(), { agentId: "agent-02" }),
    /SUBTITLE_SCOPE_MISMATCH/
  );

  assert.throws(
    () => createDeterministicSubtitlePlan(sampleNarrationPackage(), { ownerId: "bad space owner" }),
    /SUBTITLE_SCOPE_INVALID_OWNER/
  );
});

test("enforces exactly three Shorts profiles with hook, tension, cliffhanger and no ending disclosure", () => {
  const plan = createDeterministicSubtitlePlan(sampleNarrationPackage());
  assert.equal(plan.shortsPlans.length, 3);

  const roles = plan.shortsPlans.map((sp) => sp.role);
  assert.deepEqual(roles, ["opening_hook", "high_tension_moment", "cliffhanger_teaser"]);

  for (const short of plan.shortsPlans) {
    assert.equal(short.aspectRatio, "9:16");
    assert.equal(short.width, 1080);
    assert.equal(short.height, 1920);
    assert.equal(short.endingRevealAllowed, false);
  }

  const cliffhanger = plan.shortsPlans.find((sp) => sp.role === "cliffhanger_teaser");
  assert.equal(cliffhanger.endingDisclosure, "ending_not_revealed");
});

test("handler validates scope and records planning checkpoints", async () => {
  const checkpoints = [];
  const heartbeats = [];
  const ctx = {
    agentId: "agent-01",
    jobType: "jarvis.content.subtitle-plan.v1",
    context: { ownerId: "owner-99" },
    payload: { narrationPackage: sampleNarrationPackage({ ownerId: "owner-99" }) },
    heartbeat(step, progress, data) {
      heartbeats.push({ step, progress, data });
    },
    async checkpoint(step, progress, data) {
      checkpoints.push({ step, progress, data });
    },
  };

  const plan = await deterministicSubtitlePlanHandler(ctx);
  assert.equal(plan.readiness, "subtitle_plan_only");
  assert.equal(plan.ownerId, "owner-99");
  assert.deepEqual(checkpoints.map((c) => c.step), ["subtitle_segments_validated", "subtitle_plan_ready"]);

  await assert.rejects(
    deterministicSubtitlePlanHandler({ ...ctx, agentId: "agent-02" }),
    /SUBTITLE_SCOPE_MISMATCH/
  );
  await assert.rejects(
    deterministicSubtitlePlanHandler({ ...ctx, jobType: "jarvis.invalid.job" }),
    /SUBTITLE_SCOPE_MISMATCH/
  );
});
