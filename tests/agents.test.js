import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, MAX_AGENTS, PRELOADED_AGENTS } from "../src/catalog/agents.js";

test("preloads the canonical 20 agents", () => {
  const registry = new AgentRegistry();
  assert.equal(PRELOADED_AGENTS.length, 20);
  assert.equal(registry.list().length, 20);
  assert.equal(registry.get("agent-01").name, "JARVIS");
});

test("enforces the 50-agent hard cap", () => {
  const seed = Array.from({ length: MAX_AGENTS }, (_, index) => ({
    id: `x-${index}`, name: `X${index}`, namespace: `x.${index}`
  }));
  const registry = new AgentRegistry(seed);
  assert.throws(() => registry.add({
    id: "overflow", name: "OVERFLOW", namespace: "x.overflow"
  }), /AGENT_CAP_REACHED/);
});
