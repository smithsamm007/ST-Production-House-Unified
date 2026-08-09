/**
 * Credential Health Registry
 * Manages health status of opaque credential locators to fail closed
 * if a credential is classified or marked unhealthy.
 */
export class CredentialHealthRegistry {
  constructor() {
    // Stores unhealthy credential locators (e.g., "vault://...")
    this.unhealthyLocators = new Set();
  }

  /**
   * Mark a secret locator as unhealthy
   * @param {string} secretLocator
   */
  markUnhealthy(secretLocator) {
    if (secretLocator && typeof secretLocator === "string") {
      this.unhealthyLocators.add(secretLocator);
    }
  }

  /**
   * Mark a secret locator as healthy
   * @param {string} secretLocator
   */
  markHealthy(secretLocator) {
    if (secretLocator && typeof secretLocator === "string") {
      this.unhealthyLocators.delete(secretLocator);
    }
  }

  /**
   * Check if a secret locator is healthy
   * @param {string} secretLocator
   * @returns {boolean} True if healthy (or no secret/keyless), false if unhealthy
   */
  isHealthy(secretLocator) {
    if (!secretLocator) {
      return true; // Keyless/local slots have no secret locator, are always healthy
    }
    return !this.unhealthyLocators.has(secretLocator);
  }

  /**
   * Clear all unhealthy statuses (useful for test isolation)
   */
  clear() {
    this.unhealthyLocators.clear();
  }
}

export const credentialHealthRegistry = new CredentialHealthRegistry();
