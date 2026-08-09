import { sanitizeError } from "../db/postgresAdapter.js";
import { sanitizeErrorMessage } from "../recovery/recoveryContract.js";

export class CredentialAuditRepository {
  constructor(postgresAdapter) {
    if (!postgresAdapter || typeof postgresAdapter.query !== "function") {
      throw new Error("CredentialAuditRepository requires a valid PostgresAdapter instance.");
    }
    this.adapter = postgresAdapter;
  }

  /**
   * Logs an append-only credential access/action.
   * Ensures that any error message is properly redacted of secrets/locators before persisting.
   */
  async logAccess({ credentialId, ownerId, agentId, action, status, errorMessage, clientIp, userAgent }) {
    if (!credentialId) throw new Error("Missing credentialId");
    if (!ownerId) throw new Error("Missing ownerId");
    if (!agentId) throw new Error("Missing agentId");
    if (!action) throw new Error("Missing action");
    if (!status) throw new Error("Missing status");

    // Sanitize error message to prevent leaks of any sensitive data
    let cleanErrorMessage = null;
    if (errorMessage) {
      try {
        const tempClean = sanitizeErrorMessage(errorMessage);
        cleanErrorMessage = sanitizeError(new Error(tempClean)).message;
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
    const res = await this.adapter.query(sql, [
      credentialId,
      ownerId,
      agentId,
      action,
      status,
      cleanErrorMessage,
      clientIp || null,
      userAgent || null
    ]);
    return res.rows[0];
  }

  /**
   * Lists all audit logs belonging to an owner.
   */
  async listLogsByOwner(ownerId) {
    if (!ownerId) return [];
    const sql = `
      SELECT * FROM broker_credential_audit_log
      WHERE owner_id = $1
      ORDER BY performed_at DESC;
    `;
    const res = await this.adapter.query(sql, [ownerId]);
    return res.rows;
  }

  /**
   * Lists audit logs for a specific credential, ensuring owner isolation.
   */
  async listLogsByCredential(credentialId, ownerId) {
    if (!credentialId || !ownerId) return [];
    const sql = `
      SELECT * FROM broker_credential_audit_log
      WHERE credential_id = $1 AND owner_id = $2
      ORDER BY performed_at DESC;
    `;
    const res = await this.adapter.query(sql, [credentialId, ownerId]);
    return res.rows;
  }
}
