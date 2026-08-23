import { randomBytes } from "node:crypto";

export class LocatorError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "LocatorError";
    this.code = code;
  }
}

/**
 * Mint a new opaque credential locator ID.
 * Pure random ID, containing NO provider name, NO agent name, NO secret.
 * @returns {{ id: string, issuedAt: string, toString: Function, toJSON: Function }}
 */
export function mintLocator() {
  const bytes = randomBytes(32);
  const id = `loc_v1_${bytes.toString("base64url")}`;
  const issuedAt = new Date().toISOString();

  return {
    id,
    issuedAt,
    toString() {
      return this.id;
    },
    toJSON() {
      return this.id;
    }
  };
}

/**
 * Parses a raw locator string or locator object and returns { id, version }.
 * Throws LocatorError with code EMPTY | WRONG_VERSION | MALFORMED on invalid input.
 * @param {string|object} raw
 * @returns {{ id: string, version: string }}
 */
export function parseLocator(raw) {
  if (raw === null || raw === undefined) {
    throw new LocatorError("EMPTY", "Locator cannot be null or undefined");
  }

  let str;
  if (typeof raw === "string") {
    str = raw;
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "id" in raw) {
    if (typeof raw.id === "string") {
      str = raw.id;
    } else if (raw.id === null || raw.id === "") {
      throw new LocatorError("EMPTY", "Locator ID cannot be empty");
    } else {
      throw new LocatorError("MALFORMED", "Locator object ID must be a string");
    }
  } else {
    throw new LocatorError("MALFORMED", "Locator must be a string or locator object");
  }

  if (typeof str !== "string" || str.trim() === "") {
    throw new LocatorError("EMPTY", "Locator string cannot be empty");
  }

  // Check prefix
  if (!str.startsWith("loc_")) {
    throw new LocatorError("MALFORMED", "Locator must start with 'loc_' prefix");
  }

  // Check version pattern loc_v<version>_
  const versionMatch = str.match(/^loc_v([a-zA-Z0-9]+)_(.*)$/);
  if (!versionMatch) {
    throw new LocatorError("MALFORMED", "Locator missing version tag format 'loc_v<version>_'");
  }

  const [, versionTag, payload] = versionMatch;

  if (versionTag !== "1") {
    throw new LocatorError("WRONG_VERSION", `Unsupported locator version 'v${versionTag}'`);
  }

  // Validate base64url payload format and length (32 bytes base64url = 43 chars [A-Za-z0-9_-])
  if (payload.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(payload)) {
    throw new LocatorError("MALFORMED", "Invalid locator base64url payload format or length");
  }

  return {
    id: str,
    version: "v1"
  };
}

/**
 * Checks if raw is a valid locator. Never throws.
 * @param {string|object} raw
 * @returns {boolean}
 */
export function isValidLocator(raw) {
  try {
    parseLocator(raw);
    return true;
  } catch {
    return false;
  }
}
