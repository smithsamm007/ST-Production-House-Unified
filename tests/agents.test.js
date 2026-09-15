import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, MAX_AGENTS, PRELOADED_AGENTS } from "../src/catalog/agents.js";

test("preloads the canonical 21 agents (20 original + NEWTON, S-M02-01)", () => {
  const registry = new AgentRegistry();
  assert.equal(PRELOADED_AGENTS.length, 21);
  assert.equal(registry.list().length, 21);
  assert.equal(registry.get("agent-01").name, "JARVIS");
  const newton = registry.get("agent-21");
  assert.ok(newton, "NEWTON must be registered");
  assert.equal(newton.name, "NEWTON");
  assert.equal(newton.namespace, "st.agent.newton");
  assert.equal(newton.enabled, true);
});

test("NEWTON does not collide with any existing agent identity", () => {
  const registry = new AgentRegistry();
  const listed = registry.list();
  assert.equal(new Set(listed.map((a) => a.id)).size, listed.length);
  assert.equal(new Set(listed.map((a) => a.name)).size, listed.length);
  assert.equal(new Set(listed.map((a) => a.namespace)).size, listed.length);
  assert.equal(listed.filter((a) => a.name === "NEWTON").length, 1);
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
