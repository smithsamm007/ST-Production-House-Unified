import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DirectorCommunicationService,
  FileConversationStore,
  DIRECTOR_OUTCOMES,
  buildDirectorSystemInstruction,
} from "../src/communication/directorCommunicationService.js";

test("1. Owner sends 'Hi' -> Director greets and responds with DIRECTOR_RESPONDED", async () => {
  const captured = [];
  const service = new DirectorCommunicationService({
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply(input) {
        captured.push(input);
        return {
          text: "[DIRECTOR_RESPONDED] Hello! Ready to work on our next episode. What would you like to focus on?",
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Hi",
    kind: "conversation",
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.DIRECTOR_RESPONDED);
  assert.equal(res.deliveryAck.source, "system_delivery_ack");
  assert.equal(res.directorResponse.source, "director_ai");
  assert.match(res.directorResponse.body, /Hello!/i);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message, "Hi");
  assert.match(captured[0].systemInstruction, /Independent Director "agent-01"/);
});

test("2. Owner sends an informal / Hinglish business request -> Director understands and receives charter context", async () => {
  let receivedInstruction = "";
  const service = new DirectorCommunicationService({
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply({ systemInstruction, message }) {
        receivedInstruction = systemInstruction;
        assert.match(message, /bhai next ep me/i);
        return {
          text: "[TASK_ACCEPTED] Understood! I will outline a 30-second mid-roll sponsor integration draft for the next episode and submit it for your Rule 7 approval.",
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-02",
    body: "bhai next ep me ek sponsor segment add karna hai, pls draft banao",
    kind: "instruction",
    channelName: "Midnight Ward",
    charter: {
      logline: "Atmospheric supernatural mystery",
      pacing: "slow-burn tension",
    },
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.TASK_ACCEPTED);
  assert.match(receivedInstruction, /Hinglish/i);
  assert.match(receivedInstruction, /Midnight Ward/);
  assert.match(res.directorResponse.body, /Rule 7 approval/i);
});

test("3. Owner sends affiliate advertising request missing URL -> Director asks for missing details (DIRECTOR_NEEDS_CLARIFICATION)", async () => {
  const service = new DirectorCommunicationService({
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        return {
          text:
            "[DIRECTOR_NEEDS_CLARIFICATION] Hello! I understand. You want to include an advertisement for your Amazon affiliate book named Abe in our next episode.\n\n" +
            "I can evaluate how to integrate it naturally with clear affiliate disclosure without disrupting the story.\n\n" +
            "Please share the exact Amazon affiliate URL and confirm the full book title so I can prepare an approval proposal.",
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Hi, I have an Amazon affiliate link for a product. Let's create an advertisement in our next episode. It is a book named Abe.",
    kind: "conversation",
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.DIRECTOR_NEEDS_CLARIFICATION);
  assert.equal(res.directorResponse.source, "director_ai");
  assert.match(res.directorResponse.body, /Amazon affiliate/i);
  assert.match(res.directorResponse.body, /Abe/i);
  assert.match(res.directorResponse.body, /URL/i);
});

test("4. Owner supplies affiliate URL -> Director preserves exact URL verbatim", async () => {
  const exactUrl = "https://www.amazon.in/dp/B09EXAMPLE?tag=stph-21&ref=ep42";
  const service = new DirectorCommunicationService({
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply({ message }) {
        return {
          text: `[TASK_ACCEPTED] Proposal prepared for book "Abe" with clear affiliate disclosure. Preserved exact URL: ${exactUrl}. Pending your Rule 7 approval before any publishing.`,
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: `Here is the exact link for Abe: ${exactUrl}`,
    kind: "proposal",
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.TASK_ACCEPTED);
  assert.ok(
    res.directorResponse.body.includes(exactUrl),
    "Director response must preserve the exact affiliate URL verbatim"
  );
});

test("5. Gemini returns 429 quota error -> Owner receives truthful PROVIDER_UNAVAILABLE notification and distinct system ack", async () => {
  const service = new DirectorCommunicationService({
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        const err = new Error("RESOURCE_EXHAUSTED: Quota exceeded for gemini-4-hydrogen");
        err.status = 429;
        throw err;
      },
    },
  });

  const res = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Hi, can we plan episode 5?",
  });

  assert.equal(res.outcome, DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE);
  assert.equal(res.deliveryAck.source, "system_delivery_ack");
  assert.equal(res.directorResponse.source, "system_error");
  assert.match(res.directorResponse.body, /429 RESOURCE_EXHAUSTED/i);
  assert.ok(res.error, "Provider error must be surfaced honestly");
});

test("6. Two Directors receive separate messages -> zero cross-conversation leakage & unknown Director returns ROUTING_FAILED", async () => {
  const seenHistories = {};
  const service = new DirectorCommunicationService({
    knownDirectors: ["agent-01", "agent-02"],
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply({ agentId, history, message }) {
        seenHistories[agentId] = history.map((h) => h.body);
        return {
          text: `[DIRECTOR_RESPONDED] Ack from ${agentId} for: ${message}`,
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Secret plot twist for Universe A",
  });
  await service.handleOwnerMessage({
    agentId: "agent-02",
    body: "Documentary outline for Universe B",
  });

  const convA = await service.getConversation("agent-01");
  const convB = await service.getConversation("agent-02");

  assert.equal(convA.every((m) => m.agentId === "agent-01"), true);
  assert.equal(convB.every((m) => m.agentId === "agent-02"), true);
  assert.equal(
    convB.some((m) => m.body.includes("Universe A")),
    false,
    "Director B conversation must never contain Director A messages"
  );
  assert.deepEqual(seenHistories["agent-02"], []);

  const badRoute = await service.handleOwnerMessage({
    agentId: "unknown-director-99",
    body: "Hello?",
  });
  assert.equal(badRoute.outcome, DIRECTOR_OUTCOMES.ROUTING_FAILED);
});

test("7. Director response arrives after timeout & retry with same clientMessageId -> zero duplicate responses", async () => {
  let providerCalls = 0;
  const service = new DirectorCommunicationService({
    timeoutMs: 30,
    provider: {
      model: "gemini-4-hydrogen",
      async generateReply() {
        providerCalls += 1;
        await new Promise((r) => setTimeout(r, 80));
        return {
          text: "[DIRECTOR_RESPONDED] Late response after timeout",
          model: "gemini-4-hydrogen",
        };
      },
    },
  });

  const first = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Check timeout handling",
    clientMessageId: "idem-timeout-1",
  });
  assert.equal(first.outcome, DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE);
  assert.match(first.directorResponse.body, /timed out/i);

  // Wait for the slow provider promise to settle
  await new Promise((r) => setTimeout(r, 100));

  // Retry with same clientMessageId must deduplicate, not invoke provider again
  const retry = await service.handleOwnerMessage({
    agentId: "agent-01",
    body: "Check timeout handling",
    clientMessageId: "idem-timeout-1",
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(providerCalls, 1);

  const conv = await service.getConversation("agent-01");
  const ownerEntries = conv.filter((m) => m.source === "owner");
  const replyEntries = conv.filter((m) => m.sender === "director");
  assert.equal(ownerEntries.length, 1);
  assert.equal(replyEntries.length, 1, "Late response must never create a duplicate reply");
});

test("8. Conversation survives application restart via FileConversationStore", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stph-comm-"));
  const storePath = path.join(tmpDir, "conversations.json");

  try {
    const serviceBeforeRestart = new DirectorCommunicationService({
      store: new FileConversationStore(storePath),
      provider: {
        model: "gemini-4-hydrogen",
        async generateReply() {
          return {
            text: "[DIRECTOR_RESPONDED] Saved before restart for Episode 12.",
            model: "gemini-4-hydrogen",
          };
        },
      },
    });

    await serviceBeforeRestart.handleOwnerMessage({
      agentId: "agent-01",
      body: "Remember Episode 12 affiliate plan",
    });

    // Simulate full application restart with a fresh service instance
    const serviceAfterRestart = new DirectorCommunicationService({
      store: new FileConversationStore(storePath),
    });

    const restored = await serviceAfterRestart.getConversation("agent-01");
    assert.equal(restored.length, 2);
    assert.equal(restored[0].body, "Remember Episode 12 affiliate plan");
    assert.match(restored[1].body, /Saved before restart for Episode 12/);

    // Verify system instruction builder preserves Rule 7 & affiliate URL contract
    const sys = buildDirectorSystemInstruction({ agentId: "agent-01" });
    assert.match(sys, /Preserve any provided affiliate URL verbatim/i);
    assert.match(sys, /Rule 7/i);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
