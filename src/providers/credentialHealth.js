/**
 * Test-Only In-Memory Credential Health Registry
 * Kept explicitly as a test double. In production, a durable interface
 * scoped by owner, agent, slot, provider, and credential fingerprint is required.
 */
export class TestOnlyInMemoryCredentialHealthRegistry {
  constructor() {
    this.isTestOnly = true;
    this.unhealthyKeys = new Set();
  }

  _buildKey({ ownerId, agentId, slot, provider, credentialFingerprint }) {
    return `${ownerId}:${agentId}:${slot}:${provider}:${credentialFingerprint ?? "no_fingerprint"}`;
  }

  markUnhealthy({ ownerId, agentId, slot, provider, credentialFingerprint }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialFingerprint });
    this.unhealthyKeys.add(key);
  }

  markHealthy({ ownerId, agentId, slot, provider, credentialFingerprint }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialFingerprint });
    this.unhealthyKeys.delete(key);
  }

  isHealthy({ ownerId, agentId, slot, provider, credentialFingerprint }) {
    const key = this._buildKey({ ownerId, agentId, slot, provider, credentialFingerprint });
    return !this.unhealthyKeys.has(key);
  }

  clear() {
    this.unhealthyKeys.clear();
  }
}

export const testOnlyCredentialHealthRegistry = new TestOnlyInMemoryCredentialHealthRegistry();
export { TestOnlyInMemoryCredentialHealthRegistry as CredentialHealthRegistry };
