/**
 * ST Production House — Destination-aware publisher router (pure module).
 *
 * Issue #223: the owner publishing boundary previously accepted exactly ONE
 * injected `publishingPublisher` and used it for EVERY destination, which
 * made the per-platform adapters (`youtubePublisher`, `metaPublisher`,
 * `snapchatPublisher`) unreachable from the route: a `snapchat` destination
 * would have been dispatched through a YouTube-shaped publisher.
 *
 * This module is the explicit selection seam:
 *
 *   const router = createDestinationPublisherRouter({
 *     publishers: { youtube, instagram, facebook, snapchat },
 *   });
 *   const publisher = router.resolvePublisher("snapchat");
 *
 * Fail-closed principles:
 * - The destination allowlist is exactly the four supported account-isolation
 *   platforms (AGENTS.md Rule 16): youtube, instagram, facebook, snapchat.
 * - An unknown destination, an unwired destination, or a registry entry that
 *   is not an object with a `publish` function fails closed with a stable
 *   error code — it NEVER falls through to another platform's publisher.
 * - Deterministic: no clocks, no randomness, no network, no GitHub access.
 * - No secrets: publishers are passed by reference; nothing here inspects,
 *   logs, or serializes credential material (Rule 17).
 */

const SUPPORTED_DESTINATIONS = Object.freeze([
  "youtube",
  "instagram",
  "facebook",
  "snapchat",
]);

function routerError(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a destination→publisher registry entry.
 * Returns the publisher on success; throws a stable-coded error otherwise.
 */
function validateEntry(destination, publisher) {
  if (!isPlainObject(publisher) || typeof publisher.publish !== "function") {
    throw routerError("DESTINATION_PUBLISHER_INVALID", destination);
  }
  return publisher;
}

/**
 * Creates the destination-aware publisher router.
 *
 * @param {object} options
 * @param {object} options.publishers - map destination → publisher (each an
 *   object with a `publish(request)` function). Destinations may be wired
 *   selectively; unwired destinations simply fail closed at resolve time.
 * @returns {object} frozen router with:
 *   - resolvePublisher(destination): the publisher wired for that exact
 *     destination (throws `PUBLISHER_NOT_WIRED_FOR_DESTINATION` otherwise)
 *   - hasPublisher(destination): boolean, deterministic
 *   - destinations(): sorted list of wired destinations
 */
export function createDestinationPublisherRouter(options = {}) {
  if (!isPlainObject(options)) {
    throw routerError("DESTINATION_PUBLISHER_REGISTRY_INVALID");
  }
  const registry = options.publishers;
  if (registry !== undefined && !isPlainObject(registry)) {
    throw routerError("DESTINATION_PUBLISHER_REGISTRY_INVALID");
  }

  const byDestination = new Map();
  if (registry) {
    for (const destination of Object.keys(registry)) {
      if (!SUPPORTED_DESTINATIONS.includes(destination)) {
        // An unsupported destination key can never be dispatched honestly.
        throw routerError("DESTINATION_PUBLISHER_UNKNOWN_DESTINATION", destination);
      }
      byDestination.set(destination, validateEntry(destination, registry[destination]));
    }
  }

  return Object.freeze({
    supportedDestinations: SUPPORTED_DESTINATIONS,

    hasPublisher(destination) {
      if (typeof destination !== "string" || !SUPPORTED_DESTINATIONS.includes(destination)) {
        return false;
      }
      return byDestination.has(destination);
    },

    destinations() {
      return Object.freeze(
        SUPPORTED_DESTINATIONS.filter((destination) => byDestination.has(destination)),
      );
    },

    /**
     * Resolves the publisher wired for the exact destination.
     * Fails closed — never returns another platform's publisher.
     */
    resolvePublisher(destination) {
      if (typeof destination !== "string" || !SUPPORTED_DESTINATIONS.includes(destination)) {
        throw routerError("PUBLISHER_NOT_WIRED_FOR_DESTINATION", destination);
      }
      const publisher = byDestination.get(destination);
      if (!publisher) {
        throw routerError("PUBLISHER_NOT_WIRED_FOR_DESTINATION", destination);
      }
      return publisher;
    },
  });
}
