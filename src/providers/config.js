/**
 * Canonical Provider Registry (data only)
 * Defines exactly 3 private remote slots and 1 keyless local fallback slot.
 * Remote slots default to enabled: false until real credentials exist.
 */

export const CANONICAL_PROVIDERS = Object.freeze({
  p_remote_1: Object.freeze({
    id: "p_remote_1",
    kind: "remote",
    keyless: false,
    enabled: false
  }),
  p_remote_2: Object.freeze({
    id: "p_remote_2",
    kind: "remote",
    keyless: false,
    enabled: false
  }),
  p_remote_3: Object.freeze({
    id: "p_remote_3",
    kind: "remote",
    keyless: false,
    enabled: false
  }),
  p_local_fallback: Object.freeze({
    id: "p_local_fallback",
    kind: "local_open_source",
    keyless: true,
    enabled: true
  })
});

export const CANONICAL_PROVIDER_IDS = Object.freeze(Object.keys(CANONICAL_PROVIDERS));

/**
 * Default Registered Agent Policies Map (data only)
 * Maps agent policy identifiers to their default slot configuration policy.
 */
export const DEFAULT_AGENT_POLICIES = Object.freeze({
  "agent-01": Object.freeze({
    agentId: "agent-01",
    providers: Object.freeze([
      Object.freeze({ id: "p_remote_1", priority: 1, enabled: false }),
      Object.freeze({ id: "p_remote_2", priority: 2, enabled: false }),
      Object.freeze({ id: "p_remote_3", priority: 3, enabled: false }),
      Object.freeze({ id: "p_local_fallback", priority: 4, enabled: true })
    ])
  }),
  "default": Object.freeze({
    agentId: "default",
    providers: Object.freeze([
      Object.freeze({ id: "p_remote_1", priority: 1, enabled: false }),
      Object.freeze({ id: "p_remote_2", priority: 2, enabled: false }),
      Object.freeze({ id: "p_remote_3", priority: 3, enabled: false }),
      Object.freeze({ id: "p_local_fallback", priority: 4, enabled: true })
    ])
  })
});
