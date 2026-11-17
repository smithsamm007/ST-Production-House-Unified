/**
 * ST Production House — Director Isolation & 5-Platform Boundary Guard (Phase 2, v1.2).
 *
 * Enforces:
 *   - Dedicated per-Director non-privileged runtime role (`st_dir_<directorId>`)
 *   - Zero cross-Director role inheritance or arbitrary `SET ROLE` switching
 *   - Isolated per-Director connection pools (no cross-Director connection reuse)
 *   - Five independent platform account connections per Director:
 *     Instagram, Facebook, YouTube, Snapchat, Bilibili
 *     (YouTube Shorts is a publishing format on the Director's own YouTube channel)
 *   - Honest failure (`ACCOUNT_NOT_CONFIGURED`) when a slot is disconnected
 */

export const DIRECTOR_ACCOUNT_PLATFORMS = Object.freeze([
  "instagram",
  "facebook",
  "youtube",
  "snapchat",
  "bilibili",
]);

export const YOUTUBE_SHORTS_FORMAT = "youtube_shorts";

export function deriveDirectorDbRole(directorId) {
  if (typeof directorId !== "string" || !/^[a-z0-9_-]{2,40}$/i.test(directorId)) {
    throw new Error("INVALID_DIRECTOR_ID");
  }
  return `st_dir_${directorId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

export class IsolatedDirectorPoolRegistry {
  constructor() {
    this._pools = new Map();
    this._records = new Map(); // directorId -> array of owned records
    this._connections = new Map(); // `${directorId}:${platform}` -> { locator, status }
  }

  registerDirector(directorId) {
    const dbRole = deriveDirectorDbRole(directorId);
    if (!this._pools.has(directorId)) {
      this._pools.set(
        directorId,
        Object.freeze({
          poolId: `pool_${dbRole}`,
          directorId,
          dbRole,
          isSuperuser: false,
          bypassRls: false,
          inheritsOtherDirectorRoles: false,
        })
      );
      this._records.set(directorId, []);
    }
    return this._pools.get(directorId);
  }

  getIsolatedPool(directorId) {
    const pool = this._pools.get(directorId);
    if (!pool) {
      throw new Error(`DIRECTOR_POOL_NOT_FOUND:${directorId}`);
    }
    return pool;
  }

  /**
   * Simulates PostgreSQL RLS bound strictly to authenticated `current_user`
   * (`pool.dbRole`), rejecting spoofed session variables or `SET ROLE` attempts.
   */
  executeScopedQuery({ pool, operation, targetDirectorId, record = null, attemptedSetRole = null, spoofedSessionVar = null }) {
    if (!pool || !pool.dbRole || pool.isSuperuser || pool.bypassRls) {
      return { ok: false, code: "DENY_UNSAFE_DB_ROLE", rows: [] };
    }
    if (attemptedSetRole && attemptedSetRole !== pool.dbRole) {
      return {
        ok: false,
        code: "DENY_ROLE_SWITCH_PROHIBITED",
        reason: `Role '${pool.dbRole}' cannot SET ROLE to '${attemptedSetRole}'.`,
        rows: [],
      };
    }

    // Even if a caller injects `spoofedSessionVar`, RLS evaluates `pool.dbRole` ONLY.
    const expectedRole = deriveDirectorDbRole(targetDirectorId);
    const matchesAuthenticatedRole = expectedRole === pool.dbRole;

    if (operation === "SELECT") {
      if (!matchesAuthenticatedRole) {
        return { ok: true, code: "RLS_FILTERED_EMPTY", rows: [], ignoredSpoof: Boolean(spoofedSessionVar) };
      }
      return { ok: true, code: "OK", rows: [...(this._records.get(targetDirectorId) ?? [])] };
    }

    if (operation === "INSERT" || operation === "UPDATE" || operation === "DELETE") {
      if (!matchesAuthenticatedRole) {
        return {
          ok: false,
          code: "DENY_RLS_WITH_CHECK_VIOLATION",
          reason: `Authenticated role '${pool.dbRole}' cannot mutate records for '${targetDirectorId}'.`,
          rows: [],
        };
      }
      if (operation === "INSERT" && record) {
        const list = this._records.get(targetDirectorId) ?? [];
        list.push(Object.freeze({ ...record, directorId: targetDirectorId, directorRole: pool.dbRole }));
        this._records.set(targetDirectorId, list);
      }
      return { ok: true, code: "OK", rows: [] };
    }

    return { ok: false, code: "DENY_UNKNOWN_OPERATION", rows: [] };
  }

  configurePlatformSlot({ directorId, platform, vaultLocator, status = "unconfigured" }) {
    const normalized = String(platform).toLowerCase();
    if (!DIRECTOR_ACCOUNT_PLATFORMS.includes(normalized)) {
      throw new Error(`INVALID_PLATFORM_ACCOUNT:${platform}`);
    }
    if (typeof vaultLocator !== "string" || !vaultLocator.startsWith("vault://")) {
      throw new Error("OPAQUE_VAULT_LOCATOR_REQUIRED");
    }
    this.registerDirector(directorId);
    const key = `${directorId}:${normalized}`;
    const slot = Object.freeze({ directorId, platform: normalized, vaultLocator, status });
    this._connections.set(key, slot);
    return slot;
  }

  /**
   * Resolve publishing destination for a Director.
   * `youtube_shorts` routes to the Director's own `youtube` account connection.
   * Never falls back to another Director's account.
   */
  resolvePublishingAccount({ directorId, targetPlatformOrFormat, requestedAccountDirectorId = directorId }) {
    if (requestedAccountDirectorId !== directorId) {
      return {
        ok: false,
        code: "CROSS_DIRECTOR_PUBLISH_DENIED",
        reason: `Director '${directorId}' cannot publish via '${requestedAccountDirectorId}' account.`,
      };
    }
    const normalized = String(targetPlatformOrFormat).toLowerCase();
    const accountPlatform = normalized === YOUTUBE_SHORTS_FORMAT ? "youtube" : normalized;
    if (!DIRECTOR_ACCOUNT_PLATFORMS.includes(accountPlatform)) {
      return { ok: false, code: "UNSUPPORTED_PLATFORM", reason: `Unsupported platform: ${targetPlatformOrFormat}` };
    }
    const slot = this._connections.get(`${directorId}:${accountPlatform}`);
    if (!slot || slot.status === "unconfigured") {
      return {
        ok: false,
        code: "ACCOUNT_NOT_CONFIGURED",
        reason: `Director '${directorId}' has no configured '${accountPlatform}' account; honest failure (no substitution).`,
      };
    }
    return {
      ok: true,
      code: "RESOLVED",
      directorId,
      accountPlatform,
      format: normalized === YOUTUBE_SHORTS_FORMAT ? YOUTUBE_SHORTS_FORMAT : "standard",
      vaultLocator: slot.vaultLocator,
    };
  }
}
