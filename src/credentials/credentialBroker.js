export const ALLOWLISTED_SCHEMES = Object.freeze(["vault://", "opaque://"]);

// Maximum allowable lease lifetime is 5 minutes (300,000 ms)
export const MAX_LEASE_LIFETIME_MS = 300000;

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
 * Avoids walking custom prototype chains or invoking getters by using own descriptors.
 */
export function scanForPlaintextSecrets(obj, visited = new Set(), path = "", isSensitive = false) {
  if (!obj || typeof obj !== "object") return;

  if (visited.has(obj)) {
    return; // Prevent cyclic recursion
  }
  visited.add(obj);

  const descriptors = Object.getOwnPropertyDescriptors(obj);
  for (const [key, desc] of Object.entries(descriptors)) {
    // Skip potential prototype pollution vectors
    if (key === "__proto__" || key === "constructor") {
      const value = desc.value;
      if (value && typeof value === "object") {
        scanForPlaintextSecrets(value, visited, `${path}.${key}`, isSensitive);
      }
      continue;
    }

    // Reject custom accessors immediately to avoid executing getter/setter logic
    if (desc.get || desc.set) {
      throw new SecurityViolationError(
        `Plaintext secret detected at "${path ? `${path}.${key}` : key}". Custom accessors are forbidden.`
      );
    }

    const value = desc.value;
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();

    const isCurrentSecretKey = isSensitive || [
      "password", "passwd", "secret", "token", "apikey", "api_key",
      "privatekey", "private_key", "auth", "locator", "cookie",
      "header", "encoded", "credential"
    ].some(pattern => lowerKey.includes(pattern));

    if (isCurrentSecretKey) {
      if (value === null || value === undefined) {
        continue;
      }
      if (typeof value === "string") {
        const hasAllowedScheme = ALLOWLISTED_SCHEMES.some(scheme => value.startsWith(scheme));
        if (!hasAllowedScheme) {
          throw new SecurityViolationError(
            `Plaintext secret detected at "${currentPath}". Secrets must use opaque locators (e.g., vault://...).`
          );
        }
      } else if (typeof value === "object") {
        scanForPlaintextSecrets(value, visited, currentPath, true);
      } else {
        // Any other non-string primitives (number, boolean) are considered plaintext secrets if sensitive
        throw new SecurityViolationError(
          `Plaintext secret detected at "${currentPath}". Secrets must use opaque locators (e.g., vault://...).`
        );
      }
    } else {
      if (value && typeof value === "object") {
        scanForPlaintextSecrets(value, visited, currentPath, false);
      }
    }
  }
}

/**
 * Validates that the resolved secret material consists only of supported, safe structures with clear zeroization paths.
 * Rejects arrays, Dates, functions, promises, proxies/accessor-bearing objects, and arbitrary serializable DTOs.
 */
export function validateSecretMaterial(secret) {
  if (secret === null || secret === undefined) {
    throw new Error("INVALID_SECRET_MATERIAL");
  }
  if (typeof secret === "string") {
    if (secret.trim() === "") {
      throw new Error("INVALID_SECRET_MATERIAL");
    }
    return;
  }
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0) {
      throw new Error("INVALID_SECRET_MATERIAL");
    }
    return;
  }

  // Dict structure validation
  if (typeof secret === "object") {
    const proto = Object.getPrototypeOf(secret);
    if (proto !== null && proto !== Object.prototype) {
      throw new Error("INVALID_SECRET_MATERIAL"); // Reject proxies and custom prototypes
    }

    const descriptors = Object.getOwnPropertyDescriptors(secret);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (desc.get || desc.set) {
        throw new Error("INVALID_SECRET_MATERIAL"); // Reject custom accessors
      }
      const val = desc.value;
      if (val === null || val === undefined) continue;
      if (typeof val === "string") continue;
      if (Buffer.isBuffer(val)) continue;
      if (typeof val === "object") {
        validateSecretMaterial(val); // Recursively validate nested dicts
        continue;
      }
      throw new Error("INVALID_SECRET_MATERIAL"); // Reject other non-supported primitives
    }
    return;
  }
  throw new Error("INVALID_SECRET_MATERIAL");
}

/**
 * A short-lived, non-serializable lease representing a resolved credential secret.
 * The raw secret is accessible ONLY via bounded consume(callback) capability.
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

  /**
   * Only production secret access path. Always revokes/zeroizes on callback completion.
   */
  async consume(callback) {
    if (typeof callback !== "function") {
      throw new Error("CONSUME_CALLBACK_REQUIRED");
    }
    if (this.#isRevoked || Date.now() >= this.#expiresAt) {
      throw new Error("LEASE_EXPIRED_OR_REVOKED");
    }
    const secret = this.#secretValue;
    try {
      return await callback(secret);
    } finally {
      this.revoke();
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
  constructor({ repository, resolver, auditRepository }) {
    if (!repository || typeof repository.findLocatorScoped !== "function" || typeof repository.save !== "function") {
      throw new Error("INVALID_REPOSITORY: Repository must implement ICredentialRepository interface.");
    }
    if (!resolver || (typeof resolver !== "function" && typeof resolver.resolve !== "function")) {
      throw new Error("INVALID_RESOLVER: Resolver must be a function or implement a 'resolve' method.");
    }
    if (!auditRepository ||
       (typeof auditRepository.recordEvent !== "function" && typeof auditRepository.logAccess !== "function")) {
      throw new Error("INVALID_AUDIT_REPOSITORY: Audit repository must implement recordEvent or logAccess method.");
    }
    this.repository = repository;
    this.resolver = resolver;
    this.auditRepository = auditRepository;
  }

  async _resolveLocator(locator) {
    try {
      let result;
      if (typeof this.resolver === "function") {
        result = await this.resolver(locator);
      } else {
        result = await this.resolver.resolve(locator);
      }

      // Explicit strict secret type check
      validateSecretMaterial(result);

      return result;
    } catch (err) {
      throw new Error(`RESOLUTION_FAILED: ${sanitizeErrorMessage(err.message)}`);
    }
  }

  async _writeAudit({ credentialId, ownerId, agentId, provider, capability, action, status, errorCode }) {
    if (!this.auditRepository) {
      throw new Error("AUDIT_PERSISTENCE_FAILURE");
    }
    const payload = {
      credentialId,
      ownerId,
      agentId,
      provider,
      capability,
      action,
      status,
      errorCode,
      timestamp: new Date().toISOString()
    };
    try {
      if (typeof this.auditRepository.recordEvent === "function") {
        await this.auditRepository.recordEvent(payload);
      } else if (typeof this.auditRepository.logAccess === "function") {
        await this.auditRepository.logAccess(payload);
      } else {
        throw new Error("NO_VALID_AUDIT_METHOD");
      }
    } catch (err) {
      throw new Error("AUDIT_PERSISTENCE_FAILURE");
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
      if (!agentId || !provider || !capability || !locator) {
        throw new Error("INVALID_CREDENTIAL_DATA: agentId, provider, capability, and locator are required");
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
      scanForPlaintextSecrets(credentialData);

      // Save to repository (using PostgreSQL columns shape)
      const record = {
        ownerId,
        agentId,
        provider,
        capability,
        credentialId: id,
        locator,
        metadata: credentialData.metadata || null
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
    let lease = null;
    let auditOutcome = "failure";
    let errorCode = "ACCESS_DENIED";
    let isIdFoundAndValid = false;

    try {
      if (!ownerId || !agentId || !provider || !capability || !credentialId) {
        throw new Error("MISSING_AUTHORIZATION_PARAMETERS");
      }

      // Validate lease lifetime strictly
      if (
        typeof lifetimeMs !== "number" ||
        !Number.isFinite(lifetimeMs) ||
        Number.isNaN(lifetimeMs) ||
        lifetimeMs <= 0 ||
        lifetimeMs > MAX_LEASE_LIFETIME_MS
      ) {
        errorCode = "INVALID_LEASE_LIFETIME";
        throw new Error("INVALID_LEASE_LIFETIME");
      }

      // Single, horizontal-isolation db predicate query
      const locator = await this.repository.findLocatorScoped({
        ownerId,
        agentId,
        provider,
        capability,
        credentialId
      });

      if (!locator) {
        // Enforce generic access normalization
        throw new Error("ACCESS_DENIED");
      }

      // Immediately revalidate locator scheme before resolution
      if (typeof locator !== "string") {
        errorCode = "CORRUPTED_LOCATOR";
        throw new Error("ACCESS_DENIED");
      }
      const isAllowedScheme = ALLOWLISTED_SCHEMES.some(scheme => locator.startsWith(scheme));
      if (!isAllowedScheme) {
        errorCode = "CORRUPTED_LOCATOR";
        throw new Error("ACCESS_DENIED");
      }

      isIdFoundAndValid = true;

      const rawSecret = await this._resolveLocator(locator);

      lease = new CredentialLease(rawSecret, lifetimeMs);
      auditOutcome = "success";
      errorCode = null;

      // Persist access audit safely using compatible object-based API
      await this._writeAudit({
        credentialId,
        ownerId,
        agentId,
        provider,
        capability,
        action: "resolve",
        status: auditOutcome,
        errorCode
      });

      return lease;
    } catch (err) {
      // Guarantee immediate zeroization/revocation on downstream failure
      if (lease) {
        lease.revoke();
      }

      // For non-existent credential IDs, we MUST use null or a safe representation for credentialId
      // so PostgreSQL Foreign Key constraints do not prevent auditing denails!
      const auditCredentialId = isIdFoundAndValid ? credentialId : null;

      // Force durable audit recording even on access failure
      try {
        await this._writeAudit({
          credentialId: auditCredentialId,
          ownerId: ownerId || "unknown",
          agentId: agentId || "unknown",
          provider: provider || "unknown",
          capability: capability || "unknown",
          action: "resolve",
          status: auditOutcome,
          errorCode: err.message === "INVALID_LEASE_LIFETIME"
            ? "INVALID_LEASE_LIFETIME"
            : err.message.startsWith("RESOLUTION_FAILED:")
              ? "RESOLUTION_FAILED"
              : errorCode
        });
      } catch (auditErr) {
        // Fail-closed on audit persistence failure
        throw new Error("AUDIT_PERSISTENCE_FAILURE");
      }

      // Generic normalized response
      if (err.message === "INVALID_LEASE_LIFETIME") {
        throw err;
      }
      throw new Error("ACCESS_DENIED");
    }
  }
}
