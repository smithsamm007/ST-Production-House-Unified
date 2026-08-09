import { sanitizeError } from "../db/postgresAdapter.js";
import { sanitizeErrorMessage } from "../recovery/recoveryContract.js";

export class CredentialAuditRepository {
  constructor(postgresAdapter) {
    if (!postgresAdapter || typeof postgresAdapter.query !== "function") {
      throw new Error("CredentialAuditRepository requires a valid PostgresAdapter instance.");
    }
    this.adapter = postgresAdapter;
  }

  _toDTO(row) {
    if (!row) return null;
    const dto = { ...row };
    // Redact secret locators from error messages or standard audit payloads (point 6)
    if (dto.error_message) {
      dto.error_message = dto.error_message.replace(/(vault:\/\/|opaque:\/\/)[^\s'"]+/gi, "[REDACTED_LOCATOR]");
    }
    return Object.freeze(dto);
  }

  validateFields({ action, status, clientIp, userAgent }) {
    const ALLOWED_ACTIONS = ['create', 'read', 'rotate', 'revoke', 'resolve', 'update_metadata'];
    const ALLOWED_STATUSES = ['success', 'failure'];

    if (!action || typeof action !== "string" || !ALLOWED_ACTIONS.includes(action)) {
      throw new Error(`Invalid or disallowed action: ${action}`);
    }
    if (!status || typeof status !== "string" || !ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid or disallowed status: ${status}`);
    }
    if (clientIp) {
      if (typeof clientIp !== "string" || clientIp.length > 45) {
        throw new Error("clientIp exceeds max length of 45 characters");
      }
    }
    if (userAgent) {
      if (typeof userAgent !== "string" || userAgent.length > 500) {
        throw new Error("userAgent exceeds max length of 500 characters");
      }
    }
  }

  /**
   * Compatibility recordEvent method (point 3).
   */
  async recordEvent(params, client = null) {
    return this.logAccess(params, client);
  }

  /**
   * Logs an append-only credential access/action.
   */
  async logAccess(first, ...rest) {
    let params;
    let client = null;

    if (first && typeof first === "object" && !first.query) {
      // It is an object-shaped call: { credentialId, ownerId, ... }
      params = first;
      client = rest[0] || null;
    } else {
      // It is a positional call (point 1): logAccess(credentialId, ownerId, agentId, action, status, errorMessage, clientIp, userAgent, client)
      params = {
        credentialId: first,
        ownerId: rest[0],
        agentId: rest[1],
        action: rest[2],
        status: rest[3],
        errorMessage: rest[4],
        clientIp: rest[5],
        userAgent: rest[6],
      };
      client = rest[7] || null;
    }

    const { credentialId, ownerId, agentId, action, status, errorMessage, clientIp, userAgent } = params;

    if (!ownerId) throw new Error("Missing ownerId");
    if (!agentId) throw new Error("Missing agentId");

    this.validateFields({ action, status, clientIp, userAgent });

    // Sanitize error message to prevent leaks of any sensitive data (point 6)
    let cleanErrorMessage = null;
    if (errorMessage) {
      try {
        const tempClean = sanitizeErrorMessage(errorMessage);
        cleanErrorMessage = sanitizeError(new Error(tempClean)).message;
        // Bounded constraint checks for message
        if (cleanErrorMessage.length > 1000) {
          cleanErrorMessage = cleanErrorMessage.substring(0, 1000) + "... [TRUNCATED]";
        }
      } catch (e) {
        cleanErrorMessage = "[REDACTED_ERROR_SANITIZATION_FAILED]";
      }
    }

    const sql = `
      INSERT INTO broker_credential_audit_log (
        credential_id,
        owner_id,
        agent_id,
        action,
        status,
        error_message,
        client_ip,
        user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const executor = client || this.adapter;
    const res = await executor.query(sql, [
      credentialId || null,
      ownerId,
      agentId,
      action,
      status,
      cleanErrorMessage,
      clientIp || null,
      userAgent || null
    ]);
    return this._toDTO(res.rows[0]);
  }

  /**
   * Lists all audit logs belonging to an owner scoped strictly by owner+agent (point 2).
   */
  async listLogsByOwner(ownerId, agentId) {
    if (!ownerId || !agentId) {
      throw new Error("Missing required parameters ownerId or agentId");
    }
    const sql = `
      SELECT * FROM broker_credential_audit_log
      WHERE owner_id = $1 AND agent_id = $2
      ORDER BY performed_at DESC;
    `;
    const res = await this.adapter.query(sql, [ownerId, agentId]);
    return res.rows.map(row => this._toDTO(row));
  }

  /**
   * Lists audit logs for a specific credential, ensuring owner and agent isolation (point 2).
   */
  async listLogsByCredential(credentialId, ownerId, agentId) {
    if (!credentialId || !ownerId || !agentId) {
      throw new Error("Missing required parameters credentialId, ownerId, or agentId");
    }
    const sql = `
      SELECT * FROM broker_credential_audit_log
      WHERE credential_id = $1 AND owner_id = $2 AND agent_id = $3
      ORDER BY performed_at DESC;
    `;
    const res = await this.adapter.query(sql, [credentialId, ownerId, agentId]);
    return res.rows.map(row => this._toDTO(row));
  }
}
