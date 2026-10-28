import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DirectorWorkspaceRepository,
  MESSAGE_KINDS,
  MESSAGE_SENDERS,
  ROADMAP_BUCKETS,
  ROADMAP_ITEM_STATUSES,
  MEMORY_CATEGORIES,
} from "../src/catalog/directorWorkspaceRepository.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Harness (same demo-adapter contract as productionPipeline.test.js)
// ---------------------------------------------------------------------------

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const repo = new DirectorWorkspaceRepository(db);

  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@workspace.test`, "x".repeat(64), "owner", "authenticated"]
  );
  for (const [id, name, ns] of [
    ["agent-01", "JARVIS", "st.agent.jarvis"],
    ["agent-02", "SHERLOCK", "st.agent.sherlock"],
  ]) {
    await db.query("INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)", [id, name, ns, true]);
  }
  return { db, repo, ownerId };
}

// ---------------------------------------------------------------------------
// Communication window (Blueprint §7–§9): one persistent window per director
// ---------------------------------------------------------------------------

test("conversation window is a persistent singleton per (owner, director)", async () => {
  const { repo, ownerId } = await buildHarness();

  const first = await repo.getOrCreateConversation(ownerId, "agent-01");
  const again = await repo.getOrCreateConversation(ownerId, "agent-01");
  assert.equal(again.id, first.id, "the window must be created once and reused");

  const otherDirector = await repo.getOrCreateConversation(ownerId, "agent-02");
  assert.notEqual(otherDirector.id, first.id, "each director owns a separate window");
});

test("messages persist across reads in order (long-term conversation history)", async () => {
  const { repo, ownerId } = await buildHarness();

  await repo.appendMessage(ownerId, "agent-01", { sender: "owner", kind: "conversation", body: "I want to introduce a new supernatural character." });
  await repo.appendMessage(ownerId, "agent-01", { sender: "director", kind: "proposal", body: "We can develop the character while maintaining the existing universe rules." });
  await repo.appendMessage(ownerId, "agent-01", { sender: "owner", kind: "instruction", body: "Make the character morally ambiguous." });

  const messages = await repo.listMessages(ownerId, "agent-01");
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.kind), ["conversation", "proposal", "instruction"]);
  assert.match(messages[2].body, /morally ambiguous/);
  for (const message of messages) {
    assert.match(message.id, /^\d+$/, "message ids are real stored row ids");
    assert.ok(message.createdAt, "every message carries a timestamp");
  }
});

test("message kinds enforce the execution semantics and fail closed (§10)", async () => {
  const { repo, ownerId } = await buildHarness();

  assert.deepEqual([...MESSAGE_KINDS], ["conversation", "proposal", "instruction", "decision"]);
  assert.deepEqual([...MESSAGE_SENDERS], ["owner", "director"]);

  await assert.rejects(
    () => repo.appendMessage(ownerId, "agent-01", { sender: "owner", kind: "command", body: "publish now" }),
    /MESSAGE_VALIDATION_FAILED/,
    "unknown kinds must not be recorded"
  );
  await assert.rejects(
    () => repo.appendMessage(ownerId, "agent-01", { sender: "owner", kind: "decision", body: "   " }),
    /MESSAGE_VALIDATION_FAILED/,
    "empty bodies must be rejected"
  );
  // A decision is recorded as evidence — the repository returns the stored row
  // and nothing else happens (no jobs, no publishing side effects).
  const decision = await repo.appendMessage(ownerId, "agent-01", {
    sender: "owner",
    kind: "decision",
    body: "Approved. Add the space-horror concept to the roadmap.",
  });
  assert.equal(decision.kind, "decision");
});

// ---------------------------------------------------------------------------
// Roadmap (Blueprint §11): NOW / NEXT / FUTURE / IDEAS buckets
// ---------------------------------------------------------------------------

test("roadmap supports the four buckets with filtering and lifecycle", async () => {
  const { repo, ownerId } = await buildHarness();

  assert.deepEqual([...ROADMAP_BUCKETS], ["now", "next", "future", "ideas"]);
  assert.deepEqual([...ROADMAP_ITEM_STATUSES], ["open", "accepted", "done", "dismissed"]);

  await repo.addRoadmapItem(ownerId, "agent-01", { bucket: "now", title: "Episode 042" });
  await repo.addRoadmapItem(ownerId, "agent-01", { bucket: "next", title: "New character" });
  await repo.addRoadmapItem(ownerId, "agent-01", { bucket: "future", title: "Season 2" });
  await repo.addRoadmapItem(ownerId, "agent-01", { bucket: "ideas", title: "Underground city", detail: "Dormant idea" });

  const all = await repo.listRoadmap(ownerId, "agent-01");
  assert.equal(all.length, 4);

  const nowBucket = await repo.listRoadmap(ownerId, "agent-01", { bucket: "now" });
  assert.equal(nowBucket.length, 1);
  assert.equal(nowBucket[0].title, "Episode 042");
  assert.equal(nowBucket[0].status, "open");

  await assert.rejects(
    () => repo.addRoadmapItem(ownerId, "agent-01", { bucket: "someday", title: "Not a bucket" }),
    /ROADMAP_VALIDATION_FAILED/,
    "unknown buckets fail closed"
  );

  const accepted = await repo.updateRoadmapItemStatus(ownerId, nowBucket[0].id, "accepted");
  assert.equal(accepted.status, "accepted");
  const done = await repo.updateRoadmapItemStatus(ownerId, nowBucket[0].id, "done");
  assert.equal(done.status, "done");

  assert.equal(await repo.updateRoadmapItemStatus(ownerId, randomUUID(), "done"), null, "unknown item is a 404, not an error");
  await assert.rejects(
    () => repo.updateRoadmapItemStatus(ownerId, nowBucket[0].id, "cancelled"),
    /ROADMAP_VALIDATION_FAILED/,
    "status stays within the declared lifecycle"
  );
});

// ---------------------------------------------------------------------------
// Memory (Blueprint §12): isolated per owner AND per director
// ---------------------------------------------------------------------------

test("memory is isolated: no cross-director and no cross-owner reads", async () => {
  const { db, repo, ownerId } = await buildHarness();

  const secondOwnerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [secondOwnerId, `owner-${secondOwnerId.slice(0, 8)}@workspace.test`, "x".repeat(64), "owner", "authenticated"]
  );

  await repo.saveMemory(ownerId, "agent-01", { category: "characters", content: { name: "Vira", constraint: "morally ambiguous" } });
  await repo.saveMemory(ownerId, "agent-01", { category: "universe_bible", content: { rules: ["no daylight scenes"] } });
  await repo.saveMemory(ownerId, "agent-02", { category: "story_rules", content: { locked: ["fair-play clues"] } });

  const jarvisMemory = await repo.listMemory(ownerId, "agent-01");
  assert.deepEqual(jarvisMemory.map((m) => m.category), ["characters", "universe_bible"], "only this director's categories");

  const sherlockMemory = await repo.listMemory(ownerId, "agent-02");
  assert.equal(sherlockMemory.length, 1);
  assert.equal(sherlockMemory[0].category, "story_rules");

  const otherOwner = await repo.listMemory(secondOwnerId, "agent-01");
  assert.deepEqual(otherOwner, [], "another owner cannot read this director's memory");
});

test("memory upserts a singleton per category and validates input", async () => {
  const { repo, ownerId } = await buildHarness();

  await repo.saveMemory(ownerId, "agent-01", { category: "visual_identity", content: { palette: "cold" } });
  const updated = await repo.saveMemory(ownerId, "agent-01", { category: "visual_identity", content: { palette: "colder", grain: true } });
  assert.deepEqual(updated.content, { palette: "colder", grain: true });

  const entries = await repo.listMemory(ownerId, "agent-01");
  assert.equal(entries.length, 1, "the category entry is a singleton, not a log");

  await assert.rejects(
    () => repo.saveMemory(ownerId, "agent-01", { category: "diaries", content: {} }),
    /MEMORY_VALIDATION_FAILED/,
    "unknown categories fail closed"
  );
  await assert.rejects(
    () => repo.saveMemory(ownerId, "agent-01", { category: "characters", content: "prose" }),
    /MEMORY_VALIDATION_FAILED/,
    "content must be a JSON object"
  );
  await assert.rejects(
    () => repo.saveMemory(ownerId, "agent-01", { category: "characters", content: ["a"] }),
    /MEMORY_VALIDATION_FAILED/,
    "arrays are not memory objects"
  );
});

test("memory category set matches the blueprint isolation model", () => {
  assert.deepEqual([...MEMORY_CATEGORIES], [
    "universe_bible", "characters", "locations", "story_rules",
    "visual_identity", "voice_identity", "music_identity",
    "audience_insights", "owner_decisions", "production_history",
  ]);
});
