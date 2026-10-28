/**
 * Test-Only In-Memory Credential Health Registry
 * Kept explicitly as a test double. In production, a durable interface
 * scoped by owner, agent, slot, provider, and credentialId is required.
 */
export class TestOnlyInMemoryCredentialHealthRegistry {
  constructor() {
    this.isTestOnly = true;
    this.unhealthyKeys = new Set();
  }

  _buildKey({ ownerId, agentId, slot, provider, credentialId }) {
    return `${ownerId}:${agentId}:${slot}:${provider}:${credentialId ?? "no_credential"}`;
  }

  markUnhealthy({ ownerId, agentId, slot, provider, credentialId }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialId });
    this.unhealthyKeys.add(key);
  }

  markHealthy({ ownerId, agentId, slot, provider, credentialId }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialId });
    this.unhealthyKeys.delete(key);
  }

  isHealthy({ ownerId, agentId, slot, provider, credentialId }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialId });
    return !this.unhealthyKeys.has(key);
  }

  clear() {
    this.unhealthyKeys.clear();
  }
}

export const testOnlyCredentialHealthRegistry = new TestOnlyInMemoryCredentialHealthRegistry();
