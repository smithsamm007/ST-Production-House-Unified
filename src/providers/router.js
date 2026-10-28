import { CANONICAL_PROVIDERS, DEFAULT_AGENT_POLICIES } from "./config.js";

export class RoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Creates pure-data failover evidence objects for a provider chain.
 *
 * @param {Array<string>} chain - Ordered array of provider IDs
 * @param {Object|Function} [reasons={}] - Optional mapping or resolver for failover reasons
 * @returns {Array<Object>} Array of pure-data failover evidence objects
 */
export function createFailoverEvidence(chain, reasons = {}) {
  if (!Array.isArray(chain)) {
    throw new RoutingError("INVALID_CHAIN_FOR_EVIDENCE");
  }

  return Object.freeze(
    chain.map((providerId, index) => {
      let reason = `FAILOVER_ATTEMPT_${index + 1}`;
      if (typeof reasons === "function") {
        reason = reasons(providerId, index);
      } else if (typeof reasons === "object" && reasons !== null && reasons[providerId]) {
        reason = reasons[providerId];
      } else if (index === 0) {
        reason = "INITIAL_ROUTE_ATTEMPT";
      }

      return Object.freeze({
        attempt: index + 1,
        providerId,
        reason
      });
    })
  );
}

/**
 * Pure-function routing engine: given an agent policy + request context,
 * return the ordered provider chain. NO live calls. NO fabricated providers.
 *
 * @param {Object|Array|string} agentPolicy - Agent policy definition or registered identifier
 * @param {Object} [ctx={}] - Request context (e.g. { costMode: 'zero' })
 * @returns {Array<string>} Ordered array of provider IDs
 */
export function resolveChain(agentPolicy, ctx = {}) {
  if (!agentPolicy || (typeof agentPolicy !== "object" && typeof agentPolicy !== "string")) {
    throw new RoutingError("Unknown agent policy: invalid or missing agent policy");
  }

  let rawEntries = null;

  if (typeof agentPolicy === "string") {
    const policy = DEFAULT_AGENT_POLICIES[agentPolicy];
    if (!policy) {
      throw new RoutingError(`Unknown agent policy: ${agentPolicy}`);
    }
    rawEntries = policy.providers;
  } else if (Array.isArray(agentPolicy)) {
    rawEntries = agentPolicy;
  } else if (Array.isArray(agentPolicy.providers)) {
    rawEntries = agentPolicy.providers;
  } else if (Array.isArray(agentPolicy.slots)) {
    rawEntries = agentPolicy.slots;
  } else {
    // Check if plain object mapping providerId -> config
    const keys = Object.keys(agentPolicy);
    const validKeys = keys.filter((k) => CANONICAL_PROVIDERS[k] !== undefined);
    if (validKeys.length > 0) {
      rawEntries = keys.map((key) => {
        const val = agentPolicy[key];
        return typeof val === "object" && val !== null ? { id: key, ...val } : { id: key, enabled: Boolean(val) };
      });
    }
  }

  if (!rawEntries || !Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new RoutingError("Unknown agent policy: empty or unrecognized provider configuration layout");
  }

  // Validate provider entries against canonical registry
  const parsed = [];
  for (const entry of rawEntries) {
    if (!entry || (typeof entry !== "object" && typeof entry !== "string")) {
      throw new RoutingError("Unknown agent policy: invalid provider entry format");
    }

    const providerId = typeof entry === "string" ? entry : (entry.id ?? entry.providerId ?? entry.provider);
    if (!providerId || typeof providerId !== "string") {
      throw new RoutingError("Unknown agent policy: missing provider ID");
    }

    const canonical = CANONICAL_PROVIDERS[providerId];
    if (!canonical) {
      throw new RoutingError(`Fabricated provider rejected: ${providerId}`);
    }

    const enabled = typeof entry === "object" && entry.enabled !== undefined
      ? Boolean(entry.enabled)
      : canonical.enabled;

    const defaultPriority = providerId === "p_remote_1"
      ? 1
      : providerId === "p_remote_2"
      ? 2
      : providerId === "p_remote_3"
      ? 3
      : 4;

    const priority = typeof entry === "object" && typeof entry.priority === "number"
      ? entry.priority
      : defaultPriority;

    const isLocalFallback = canonical.keyless || canonical.kind === "local_open_source" || providerId === "p_local_fallback";

    parsed.push({
      id: providerId,
      enabled,
      priority,
      isLocalFallback
    });
  }

  // Filter out disabled providers - disabled providers never appear in any chain
  const enabledEntries = parsed.filter((item) => item.enabled === true);

  // Sort entries based on costMode
  const isZeroCost = ctx?.costMode === "zero";

  enabledEntries.sort((a, b) => {
    if (isZeroCost) {
      if (a.isLocalFallback !== b.isLocalFallback) {
        return a.isLocalFallback ? -1 : 1;
      }
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return 0;
  });

  const chain = enabledEntries.map((item) => item.id);
  const evidence = createFailoverEvidence(chain, ctx?.reasons ?? {});

  Object.defineProperty(chain, "evidence", {
    value: evidence,
    writable: false,
    enumerable: false,
    configurable: false
  });

  Object.defineProperty(chain, "failoverEvidence", {
    value: evidence,
    writable: false,
    enumerable: false,
    configurable: false
  });

  return chain;
}
