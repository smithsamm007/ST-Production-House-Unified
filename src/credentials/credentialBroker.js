export const ALLOWLISTED_SCHEMES = Object.freeze(["vault://", "opaque://"]);

export class SecurityViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityViolationError";
  }
}

export class CredentialValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialValidationError";
  }
}

/**
 * Sanitizes an error message by removing sensitive vault/opaque locators and potential plaintext secrets.
 */
export function sanitizeErrorMessage(message) {
  if (!message) return "";
  let msg = typeof message === "string" ? message : (message?.message ?? String(message));

  // Redact any opaque/vault paths: (vault|opaque)://...
  msg = msg.replace(/(?:vault|opaque):\/\/[^\s"',;()]+/gi, "[REDACTED_VAULT_LOCATOR]");

  // Redact potential API keys / secrets (alphanumeric, typical headers, tokens)
  msg = msg.replace(/(?:api_key|apikey|token|auth|password|secret)[=:][\w\-~.]+/gi, (match) => {
    const parts = match.split(/[=:]/);
    return `${parts[0]}:[REDACTED]`;
  });

  return msg;
}

/**
 * Recursively scans an object for plaintext secrets under keys resembling sensitive names.
 * Sensitive keys (e.g., contains 'password', 'secret', 'token', 'apikey', 'privatekey', 'auth')
 * must have values starting with an allowlisted locator scheme.
 */
export function scanForPlaintextSecrets(obj, path = "") {
  if (!obj || typeof obj !== "object") return;

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();

    if (typeof value === "string") {
      const isSecretKey =
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("token") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("privatekey") ||
        lowerKey.includes("auth") ||
        lowerKey.includes("locator");

      if (isSecretKey) {
        const hasAllowedScheme = ALLOWLISTED_SCHEMES.some(scheme => value.startsWith(scheme));
        if (!hasAllowedScheme) {
          throw new SecurityViolationError(
            `Plaintext secret detected at "${currentPath}". Secrets must use opaque locators (e.g., vault://...).`
          );
        }
      }
    } else if (typeof value === "object" && value !== null) {
      scanForPlaintextSecrets(value, currentPath);
    }
  }
}

/**
 * A short-lived, non-serializable lease representing a resolved credential secret.
 */
export class CredentialLease {
  #secretValue;
  #isRevoked = false;
  #expiresAt;
  #timer = null;

  constructor(secretValue, lifetimeMs = 30000) {
    this.#secretValue = secretValue;
    this.#expiresAt = Date.now() + lifetimeMs;

    if (lifetimeMs > 0 && lifetimeMs !== Infinity) {
      this.#timer = setTimeout(() => {
        this.revoke();
      }, lifetimeMs);
      if (this.#timer && typeof this.#timer.unref === "function") {
        this.#timer.unref();
      }
    }
  }

  getSecret() {
    if (this.#isRevoked || Date.now() >= this.#expiresAt) {
      throw new Error("LEASE_EXPIRED_OR_REVOKED");
    }
    return this.#secretValue;
  }

  get isExpired() {
    return Date.now() >= this.#expiresAt;
  }

  get isRevoked() {
    return this.#isRevoked;
  }

  revoke() {
    if (this.#isRevoked) return;
    this.#isRevoked = true;

    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    // Zeroize cached secret material where possible
    if (this.#secretValue) {
      if (Buffer.isBuffer(this.#secretValue)) {
        this.#secretValue.fill(0);
      } else if (typeof this.#secretValue === "object") {
        const zeroizeObj = (obj) => {
          for (const key of Object.keys(obj)) {
            if (Buffer.isBuffer(obj[key])) {
              obj[key].fill(0);
            } else if (typeof obj[key] === "object" && obj[key] !== null) {
              zeroizeObj(obj[key]);
            }
            obj[key] = null;
          }
        };
        zeroizeObj(this.#secretValue);
      }
      this.#secretValue = null;
    }
  }

  // Override toJSON to ensure it's non-serializable and won't leak secret material
  toJSON() {
    return undefined;
  }
}

/**
 * Production-safe credential broker contract enforcing opaque locators and 5-dimensional security bounds.
 */
export class CredentialBroker {
  constructor({ repository, resolver }) {
    if (!repository) {
      throw new Error("REPOSITORY_REQUIRED: A valid credential repository is required in the constructor.");
    }
    this.repository = repository;
    this.resolver = resolver;
  }

  async _resolveLocator(locator) {
    if (!this.resolver) {
      throw new Error("RESOLVER_NOT_CONFIGURED");
    }
    try {
      if (typeof this.resolver === "function") {
        return await this.resolver(locator);
      }
      if (typeof this.resolver.resolve === "function") {
        return await this.resolver.resolve(locator);
      }
      throw new Error("INVALID_RESOLVER_INTERFACE");
    } catch (err) {
      throw new Error(`RESOLUTION_FAILED: ${sanitizeErrorMessage(err.message)}`);
    }
  }

  async register(ownerId, credentialData) {
    try {
      if (!ownerId) {
        throw new Error("INVALID_OWNER: ownerId is required");
      }
      if (!credentialData || typeof credentialData !== "object") {
        throw new Error("INVALID_CREDENTIAL_DATA: credentialData must be an object");
      }

      const { id, agentId, provider, capability, locator } = credentialData;
      if (!id || !agentId || !provider || !capability || !locator) {
        throw new Error("INVALID_CREDENTIAL_DATA: id, agentId, provider, capability, and locator are required");
      }

      if (typeof locator !== "string") {
        throw new Error("INVALID_LOCATOR: locator must be a string");
      }

      const isAllowedScheme = ALLOWLISTED_SCHEMES.some(scheme => locator.startsWith(scheme));
      if (!isAllowedScheme) {
        throw new SecurityViolationError(
          `Invalid locator scheme. Locator must start with an allowlisted scheme (e.g. vault://, opaque://)`
        );
      }

      // Recursively scan the credentialData input for plaintext secrets in any sensitive fields
      scanForPlaintextSecrets(credentialData, "credentialData");

      // Save to repository (ensuring ownerId is bound)
      const record = {
        ...credentialData,
        ownerId
      };

      return await this.repository.save(record);
    } catch (err) {
      if (err instanceof SecurityViolationError) {
        throw err;
      }
      throw new Error(sanitizeErrorMessage(err.message));
    }
  }

  async resolve({ ownerId, agentId, provider, capability, credentialId, lifetimeMs = 30000 }) {
    try {
      if (!ownerId || !agentId || !provider || !capability || !credentialId) {
        throw new Error("MISSING_AUTHORIZATION_PARAMETERS");
      }

      const credential = await this.repository.findById(credentialId);
      if (!credential) {
        throw new Error("ACCESS_DENIED: Credential not found or access unauthorized");
      }

      // Authorization binds owner, agent, provider, capability/task, and credential identity
      if (credential.ownerId !== ownerId) {
        throw new Error("ACCESS_DENIED: Owner mismatch");
      }
      if (credential.agentId !== agentId) {
        throw new Error("ACCESS_DENIED: Agent mismatch");
      }
      if (credential.provider !== provider) {
        throw new Error("ACCESS_DENIED: Provider mismatch");
      }
      if (credential.capability !== capability) {
        throw new Error("ACCESS_DENIED: Capability mismatch");
      }

      const rawSecret = await this._resolveLocator(credential.locator);
      return new CredentialLease(rawSecret, lifetimeMs);
    } catch (err) {
      throw new Error(sanitizeErrorMessage(err.message));
    }
  }
}
