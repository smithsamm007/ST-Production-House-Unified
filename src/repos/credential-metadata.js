/**
 * Credential Metadata Repository
 *
 * Handles durable storage for credential metadata and immutable audit logs in PostgreSQL.
 * Secret VALUES are strictly forbidden — metadata only.
 * Every function receives an injected database client interface with .query(sql, params).
 * Strictly enforces parameterized queries ($1, $2...) with zero string interpolation of user data.
 */

const ALLOWED_STATUSES = Object.freeze(['provisioned', 'active', 'cooldown', 'revoked']);
const ALLOWED_EVENTS = Object.freeze(['created', 'status_changed', 'rotated', 'revoked', 'accessed']);

/**
 * Validates locator ID to ensure secret values are not stored directly.
 * Locators MUST be opaque handles starting with 'vault://' or 'opaque://'.
 *
 * @param {string} locatorId
 */
export function validateLocatorId(locatorId) {
  if (!locatorId || typeof locatorId !== 'string') {
    throw new Error('Invalid locatorId: Must be a non-empty string.');
  }
  const trimmed = locatorId.trim();
  if (!trimmed.startsWith('vault://') && !trimmed.startsWith('opaque://')) {
    throw new Error(
      'Forbidden locatorId format: Raw secret values are prohibited. ' +
      'Locator must begin with vault:// or opaque://'
    );
  }
  return trimmed;
}

/**
 * Validates query client parameter.
 *
 * @param {Object} client
 */
function assertClient(client) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('Injected client interface with query() method is required.');
  }
}

/**
 * Creates credential metadata.
 *
 * @param {Object} client Injected query client
 * @param {Object} metadata
 * @returns {Promise<Object>} Created metadata row
 */
export async function createCredentialMetadata(client, {
  locatorId,
  providerId,
  status = 'provisioned',
  scopeLabel,
  expiresAt = null,
  createdBy,
  createdAt = null,
}) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  if (!providerId || typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error('Invalid providerId: Must be a non-empty string.');
  }
  if (!scopeLabel || typeof scopeLabel !== 'string' || !scopeLabel.trim()) {
    throw new Error('Invalid scopeLabel: Must be a non-empty string.');
  }
  if (!createdBy || typeof createdBy !== 'string' || !createdBy.trim()) {
    throw new Error('Invalid createdBy: Must be a non-empty string.');
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid status: '${status}'. Allowed statuses are: ${ALLOWED_STATUSES.join(', ')}`);
  }

  const sql = `
    INSERT INTO credential_metadata (
      locator_id,
      provider_id,
      status,
      scope_label,
      expires_at,
      created_by,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
    RETURNING *;
  `;

  const params = [
    cleanLocatorId,
    providerId.trim(),
    status,
    scopeLabel.trim(),
    expiresAt ? new Date(expiresAt) : null,
    createdBy.trim(),
    createdAt ? new Date(createdAt) : null,
  ];

  const res = await client.query(sql, params);
  return res.rows[0];
}

/**
 * Retrieves credential metadata by locator ID.
 *
 * @param {Object} client Injected query client
 * @param {string} locatorId
 * @returns {Promise<Object|null>} Metadata row or null
 */
export async function getCredentialMetadata(client, locatorId) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  const sql = 'SELECT * FROM credential_metadata WHERE locator_id = $1;';
  const params = [cleanLocatorId];

  const res = await client.query(sql, params);
  return res.rows[0] || null;
}

/**
 * Updates status of credential metadata.
 *
 * @param {Object} client Injected query client
 * @param {string} locatorId
 * @param {string} newStatus
 * @returns {Promise<Object|null>} Updated metadata row
 */
export async function updateCredentialStatus(client, locatorId, newStatus) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  if (!ALLOWED_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: '${newStatus}'. Allowed statuses are: ${ALLOWED_STATUSES.join(', ')}`);
  }

  const sql = `
    UPDATE credential_metadata
    SET status = $2
    WHERE locator_id = $1
    RETURNING *;
  `;
  const params = [cleanLocatorId, newStatus];

  const res = await client.query(sql, params);
  return res.rows[0] || null;
}

/**
 * Records a credential rotation event on metadata.
 *
 * @param {Object} client Injected query client
 * @param {string} locatorId
 * @param {Object} [options]
 * @param {Date|string} [options.rotatedAt]
 * @param {Date|string} [options.expiresAt]
 * @param {string} [options.status]
 * @returns {Promise<Object|null>} Updated metadata row
 */
export async function rotateCredentialMetadata(client, locatorId, { rotatedAt = null, expiresAt = null, status = null } = {}) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  if (status !== null && !ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid status: '${status}'. Allowed statuses are: ${ALLOWED_STATUSES.join(', ')}`);
  }

  const sql = `
    UPDATE credential_metadata
    SET rotated_at = COALESCE($2, NOW()),
        expires_at = COALESCE($3, expires_at),
        status = COALESCE($4, status)
    WHERE locator_id = $1
    RETURNING *;
  `;
  const params = [
    cleanLocatorId,
    rotatedAt ? new Date(rotatedAt) : null,
    expiresAt ? new Date(expiresAt) : null,
    status,
  ];

  const res = await client.query(sql, params);
  return res.rows[0] || null;
}

/**
 * Lists credential metadata entries with optional filters.
 *
 * @param {Object} client Injected query client
 * @param {Object} [filters]
 * @param {string} [filters.providerId]
 * @param {string} [filters.status]
 * @returns {Promise<Array<Object>>}
 */
export async function listCredentialMetadata(client, { providerId = null, status = null } = {}) {
  assertClient(client);

  const conditions = [];
  const params = [];

  if (providerId) {
    params.push(providerId);
    conditions.push(`provider_id = $${params.length}`);
  }

  if (status) {
    if (!ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid status filter: '${status}'.`);
    }
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  let sql = 'SELECT * FROM credential_metadata';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC;';

  const res = await client.query(sql, params);
  return res.rows;
}

/**
 * Appends an audit log entry to the immutable credential audit trail.
 * NOTE: There are NO update or delete functions for audit log entries.
 *
 * @param {Object} client Injected query client
 * @param {Object} auditData
 * @param {string} auditData.locatorId
 * @param {string} auditData.event
 * @param {string} auditData.actor
 * @param {Object} [auditData.detail]
 * @returns {Promise<Object>} Inserted audit log row
 */
export async function appendAuditLog(client, {
  locatorId,
  event,
  actor,
  detail = {},
}) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  if (!event || typeof event !== 'string' || !ALLOWED_EVENTS.includes(event)) {
    throw new Error(`Invalid audit event: '${event}'. Allowed events: ${ALLOWED_EVENTS.join(', ')}`);
  }
  if (!actor || typeof actor !== 'string' || !actor.trim()) {
    throw new Error('Invalid actor: Must be a non-empty string.');
  }

  const sql = `
    INSERT INTO credential_audit_log (
      locator_id,
      event,
      actor,
      detail,
      occurred_at
    ) VALUES ($1, $2, $3, $4, NOW())
    RETURNING *;
  `;

  const params = [
    cleanLocatorId,
    event,
    actor.trim(),
    JSON.stringify(detail || {}),
  ];

  const res = await client.query(sql, params);
  return res.rows[0];
}

/**
 * Retrieves audit log entries for a credential by locator ID.
 *
 * @param {Object} client Injected query client
 * @param {string} locatorId
 * @returns {Promise<Array<Object>>} Audit log rows ordered by occurrence
 */
export async function getAuditLogsByLocator(client, locatorId) {
  assertClient(client);
  const cleanLocatorId = validateLocatorId(locatorId);

  const sql = 'SELECT * FROM credential_audit_log WHERE locator_id = $1 ORDER BY id ASC;';
  const params = [cleanLocatorId];

  const res = await client.query(sql, params);
  return res.rows;
}

/**
 * Class-based repository interface wrapping standalone credential metadata functions.
 */
export class CredentialMetadataRepository {
  constructor(client) {
    if (client) {
      assertClient(client);
      this.client = client;
    }
  }

  createMetadata(clientOrData, data) {
    if (data !== undefined) return createCredentialMetadata(clientOrData, data);
    return createCredentialMetadata(this.client, clientOrData);
  }

  getMetadata(clientOrLocator, locatorId) {
    if (locatorId !== undefined) return getCredentialMetadata(clientOrLocator, locatorId);
    return getCredentialMetadata(this.client, clientOrLocator);
  }

  updateStatus(clientOrLocator, locatorIdOrStatus, status) {
    if (status !== undefined) return updateCredentialStatus(clientOrLocator, locatorIdOrStatus, status);
    return updateCredentialStatus(this.client, clientOrLocator, locatorIdOrStatus);
  }

  rotateMetadata(clientOrLocator, locatorIdOrOptions, options) {
    if (options !== undefined) return rotateCredentialMetadata(clientOrLocator, locatorIdOrOptions, options);
    return rotateCredentialMetadata(this.client, clientOrLocator);
  }

  listMetadata(clientOrFilters, filters) {
    if (filters !== undefined) return listCredentialMetadata(clientOrFilters, filters);
    return listCredentialMetadata(this.client, clientOrFilters);
  }

  appendAudit(clientOrData, data) {
    if (data !== undefined) return appendAuditLog(clientOrData, data);
    return appendAuditLog(this.client, clientOrData);
  }

  getAuditLogs(clientOrLocator, locatorId) {
    if (locatorId !== undefined) return getAuditLogsByLocator(clientOrLocator, locatorId);
    return getAuditLogsByLocator(this.client, clientOrLocator);
  }
}
