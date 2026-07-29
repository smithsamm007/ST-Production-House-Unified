export const MAX_AGENTS = 50;

export const PRELOADED_AGENTS = Object.freeze([
  "JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA",
  "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN",
  "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA",
  "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"
].map((name, index) => Object.freeze({
  id: `agent-${String(index + 1).padStart(2, "0")}`,
  name,
  namespace: `st.agent.${name.toLowerCase()}`,
  enabled: true
})));

export class AgentRegistry {
  #agents = new Map();

  constructor(agents = PRELOADED_AGENTS) {
    for (const agent of agents) this.add(agent);
  }

  add(agent) {
    if (!agent?.id || !agent?.name || !agent?.namespace) {
      throw new Error("INVALID_AGENT");
    }
    if (this.#agents.size >= MAX_AGENTS) throw new Error("AGENT_CAP_REACHED");
    if (this.#agents.has(agent.id)) throw new Error("DUPLICATE_AGENT_ID");
    if ([...this.#agents.values()].some((item) =>
      item.name === agent.name || item.namespace === agent.namespace)) {
      throw new Error("DUPLICATE_AGENT_IDENTITY");
    }
    this.#agents.set(agent.id, Object.freeze({ ...agent }));
    return this.#agents.get(agent.id);
  }

  get(id) {
    return this.#agents.get(id) ?? null;
  }

  list() {
    return [...this.#agents.values()];
  }
}
