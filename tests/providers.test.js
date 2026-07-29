import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter, validateTaskProviderPolicy } from "../src/providers/providerRouter.js";

const hash = "a".repeat(64);
const slots = [
  { slot: "primary", kind: "remote", provider: "gemini",
    credentialRef: { agentId: "agent-01", slot: "primary", secretLocator: "vault://a/gemini" } },
  { slot: "secondary", kind: "remote", provider: "claude",
    credentialRef: { agentId: "agent-01", slot: "secondary", secretLocator: "vault://a/claude" } },
  { slot: "tertiary", kind: "remote", provider: "sarvam",
    credentialRef: { agentId: "agent-01", slot: "tertiary", secretLocator: "vault://a/sarvam" } },
  { slot: "open_source_emergency", kind: "local_open_source", provider: "ollama",
    credentialRef: null }
];

test("rejects cross-agent credential sharing", () => {
  const unsafe = structuredClone(slots);
  unsafe[1].credentialRef.agentId = "agent-02";
  assert.throws(() => validateTaskProviderPolicy("agent-01", unsafe),
    /CROSS_AGENT_CREDENTIAL_ACCESS_DENIED/);
});

test("fails over through three private providers to local emergency", async () => {
  const router = new ProviderRouter({
    gemini: async () => { throw new Error("RATE_LIMIT"); },
    claude: async () => { throw new Error("TIMEOUT"); },
    sarvam: async () => ({ output: "", evidence: {} }),
    ollama: async () => ({ output: "local result", evidence: { artifactSha256: hash } })
  });
  const result = await router.execute({
    agentId: "agent-01", taskId: "task-1", slots, input: "story"
  });
  assert.equal(result.selectedProvider, "ollama");
  assert.equal(result.attempts.length, 4);
  assert.equal(result.attempts.at(-1).outcome, "verified_success");
});
