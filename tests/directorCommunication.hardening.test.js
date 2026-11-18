/**
 * Director Communication — hardening regressions (mocked provider).
 *
 * These tests exercise the service against a repository that implements the
 * durable contract (per-message append, unique clientMessageId per role,
 * total order). The provider is a MOCK: no network call is made and nothing
 * here is evidence of a live Gemini conversation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DirectorCommunicationService,
  DIRECTOR_OUTCOMES,
  MAX_MESSAGE_LENGTH,
} from "../src/communication/directorCommunicationService.js";

/** In-memory stand-in for PostgresConversationRepository (same contract). */
function createFakeRepository() {
  const rows = new Map();
  let seq = 0;
  const keyOf = (ownerId, agentId, clientMessageId, role) =>
    `${ownerId}|${agentId}|${clientMessageId}|${role}`;

  return {
    rows,
    async listMessages(ownerId, agentId) {
      return [...rows.values()]
        .filter((row) => row.ownerId === ownerId && row.agentId === agentId)
        .sort((a, b) => a.seq - b.seq);
    },
    async appendMessage(ownerId, agentId, message) {
      // Widen the interleaving window so concurrent callers really race.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const role = message.sender === "owner" ? "owner" : "director";
      const key = keyOf(ownerId, agentId, message.clientMessageId, role);
      if (rows.has(key)) return { message: rows.get(key), created: false };
      const stored = { ...message, ownerId, agentId, seq: ++seq };
      rows.set(key, stored);
      return { message: stored, created: true };
    },
    async findDelivery(ownerId, agentId, clientMessageId) {
      const list = [...rows.values()]
        .filter(
          (row) =>
            row.ownerId === ownerId &&
            row.agentId === agentId &&
            row.clientMessageId === clientMessageId
        )
        .sort((a, b) => a.seq - b.seq);
      const owner = list.find((row) => row.sender === "owner");
      if (!owner) return null;
      return {
        ownerMessage: owner,
        directorResponse: list.find((row) => row.sender !== "owner") ?? null,
      };
    },
  };
}

test("9. oversized message is rejected before any provider call or storage", async () => {
  let providerCalls = 0;
  const service = new DirectorCommunicationService({
    repository: createFakeRepository(),
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        providerCalls += 1;
        return { text: "[DIRECTOR_RESPONDED] should not run", model: "gemini-4-hydrogen" };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-1",
    body: "x".repeat(MAX_MESSAGE_LENGTH + 1),
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON);
  assert.equal(res.errorCode, "MESSAGE_TOO_LONG");
  assert.equal(providerCalls, 0);
  assert.deepEqual(await service.getConversation("agent-01", { ownerId: "owner-1" }), []);
});

test("10. concurrent identical clientMessageId produces exactly one stored reply", async () => {
  let providerCalls = 0;
  const repository = createFakeRepository();
  const provider = {
    model: "gemini-4-hydrogen",
    async generateReply() {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: "[DIRECTOR_RESPONDED] One reply only.", model: "gemini-4-hydrogen" };
    },
  };
  // Two instances share the durable store (the multi-instance case).
  const a = new DirectorCommunicationService({ repository, provider });
  const b = new DirectorCommunicationService({ repository, provider });

  const [first, second] = await Promise.all([
    a.handleOwnerMessage({
      agentId: "agent-01",
      ownerId: "owner-1",
      body: "Draft the sponsor segment",
      clientMessageId: "cmid-concurrent-0001",
    }),
    b.handleOwnerMessage({
      agentId: "agent-01",
      ownerId: "owner-1",
      body: "Draft the sponsor segment",
      clientMessageId: "cmid-concurrent-0001",
    }),
  ]);

  const directorRows = [...repository.rows.values()].filter(
    (row) => row.sender !== "owner"
  );
  assert.equal(directorRows.length, 1, "exactly one reply row may be persisted");
  assert.equal(
    first.directorResponse.id,
    second.directorResponse.id,
    "both callers observe the same durable reply"
  );
  assert.ok(providerCalls >= 1);
});

test("11. idempotency survives a restart: a new instance replays the stored result", async () => {
  const repository = createFakeRepository();
  let providerCalls = 0;
  const first = new DirectorCommunicationService({
    repository,
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        providerCalls += 1;
        return {
          text: "[TASK_ACCEPTED] Proposal stored for approval.",
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const original = await first.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-1",
    body: "Prepare the Abe advertisement proposal",
    clientMessageId: "cmid-restart-0001",
  });

  // Simulate a process restart: brand-new service, same durable repository.
  const afterRestart = new DirectorCommunicationService({
    repository,
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        providerCalls += 1;
        throw new Error("provider must not be called on an idempotent replay");
      },
    },
  });

  const replay = await afterRestart.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-1",
    body: "Prepare the Abe advertisement proposal",
    clientMessageId: "cmid-restart-0001",
  });

  assert.equal(replay.deduplicated, true);
  assert.equal(providerCalls, 1, "the replay must not reach the provider");
  assert.equal(replay.directorResponse.id, original.directorResponse.id);
  assert.equal(
    (await afterRestart.getConversation("agent-01", { ownerId: "owner-1" })).length,
    2
  );
});

test("12. provider timeout aborts the in-flight request and is classified, not faked", async () => {
  let observedSignal = null;
  let providerResolvedLate = false;
  const service = new DirectorCommunicationService({
    timeoutMs: 20,
    repository: createFakeRepository(),
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply({ signal }) {
        observedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 60));
        providerResolvedLate = true;
        return { text: "[DIRECTOR_RESPONDED] too late", model: "gemini-4-hydrogen" };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-1",
    body: "Plan episode 7",
    clientMessageId: "cmid-timeout-0001",
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE);
  assert.equal(res.errorCode, "PROVIDER_TIMEOUT");
  assert.equal(res.httpStatus, 504);
  assert.ok(observedSignal?.aborted, "the provider request must be aborted on timeout");
  assert.match(res.directorResponse.body, /timed out/i);
  assert.equal(res.directorResponse.source, "system_error");
  assert.equal(typeof res.directorResponse.latencyMs, "number");

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(providerResolvedLate, true);
  const conversation = await service.getConversation("agent-01", { ownerId: "owner-1" });
  assert.equal(
    conversation.filter((message) => message.sender === "director").length,
    1,
    "a late provider resolution must never append a second reply"
  );
});

test("13. the durable reply records model, latency, correlation id and provider response id", async () => {
  const service = new DirectorCommunicationService({
    repository: createFakeRepository(),
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        return {
          text: "[DIRECTOR_NEEDS_CLARIFICATION] Please share the exact affiliate URL.",
          model: "gemini-4-hydrogen",
          responseId: "resp-abc123",
          usage: { totalTokenCount: 42 },
        };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-1",
    body: "Advertise the book Abe in episode 4",
    clientMessageId: "cmid-evidence-0001",
    correlationId: "corr-evidence-0001",
  });

  const conversation = await service.getConversation("agent-01", { ownerId: "owner-1" });
  const reply = conversation.find((message) => message.source === "director_ai");

  assert.ok(reply, "the AI reply must be stored");
  assert.equal(reply.model, "gemini-4-hydrogen");
  assert.equal(reply.correlationId, "corr-evidence-0001");
  assert.equal(typeof reply.latencyMs, "number");
  assert.equal(reply.providerResponseId, "resp-abc123");
  assert.deepEqual(reply.usage, { totalTokenCount: 42 });
  assert.equal(res.outcome, DIRECTOR_OUTCOMES.DIRECTOR_NEEDS_CLARIFICATION);
});

test("14. a Director conversation is Owner-scoped as well as Director-scoped", async () => {
  const repository = createFakeRepository();
  const service = new DirectorCommunicationService({
    repository,
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        return { text: "[DIRECTOR_RESPONDED] Noted.", model: "gemini-4-hydrogen" };
      },
    },
  });

  await service.handleOwnerMessage({
    agentId: "agent-01",
    ownerId: "owner-a",
    body: "Owner A secret plan",
    clientMessageId: "cmid-scope-0001",
  });

  assert.equal(
    (await service.getConversation("agent-01", { ownerId: "owner-b" })).length,
    0,
    "another Owner must not read this conversation"
  );
  assert.equal(
    (await service.getConversation("agent-02", { ownerId: "owner-a" })).length,
    0,
    "another Director must not read this conversation"
  );
});
