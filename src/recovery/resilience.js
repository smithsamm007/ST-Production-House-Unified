// Task 3.7: Durable Quarantine, Owner Alerts, and Emergency Pause
// Implements resilience controls that prevent execution when providers fail or owners invoke emergency pause.

export class QuarantineRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("QuarantineRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async activateQuarantine(
    {
      ownerId,
      agentId,
      slot,
      provider,
      credentialKey,
      reason,
      triggeredByEvent,
      evidenceSummary
    }
  ) {
    if (!ownerId || !agentId || !provider || !credentialKey || !reason) {
      throw new Error(
        "activateQuarantine requires ownerId, agentId, provider, credentialKey, reason"
      );
    }
    if (!slot || !["primary", "secondary", "tertiary", "emergency_1", "emergency_2"].includes(slot)) {
      throw new Error("Invalid slot");
    }
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 500) {
      throw new Error("reason must be 1-500 characters");
    }
    if (typeof triggeredByEvent !== "string" || triggeredByEvent.length < 1 || triggeredByEvent.length > 200) {
      throw new Error("triggeredByEvent must be 1-200 characters");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO provider_quarantines (
          owner_id, agent_id, slot, provider, credential_key,
          reason, triggered_by_event, evidence_summary, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (owner_id, agent_id, slot, provider, credential_key, is_active)
        DO UPDATE SET
          reason = EXCLUDED.reason,
          triggered_by_event = EXCLUDED.triggered_by_event,
          evidence_summary = EXCLUDED.evidence_summary,
          updated_at = now()
        RETURNING *
        `,
        [
          ownerId,
          agentId,
          slot,
          provider,
          credentialKey,
          reason,
          triggeredByEvent,
          evidenceSummary ? JSON.stringify(evidenceSummary) : null
        ]
      );
      return result.rows[0];
    } finally {
      await conn.release();
    }
  }

  async isQuarantined({ ownerId, agentId, slot, provider, credentialKey }) {
    if (!ownerId || !agentId || !provider || !credentialKey) {
      throw new Error(
        "isQuarantined requires ownerId, agentId, provider, credentialKey"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT id, is_active FROM provider_quarantines
        WHERE owner_id = $1
          AND agent_id = $2
          AND slot = $3
          AND provider = $4
          AND credential_key = $5
          AND is_active = true
        LIMIT 1
        `,
        [ownerId, agentId, slot, provider, credentialKey]
      );
      return result.rows.length > 0;
    } finally {
      await conn.release();
    }
  }

  async resolveQuarantine({
    ownerId,
    agentId,
    slot,
    provider,
    credentialKey,
    resolvedByOwnerId,
    resolutionNote
  }) {
    if (!ownerId || !agentId || !provider || !credentialKey || !resolvedByOwnerId) {
      throw new Error(
        "resolveQuarantine requires ownerId, agentId, provider, credentialKey, resolvedByOwnerId"
      );
    }
    if (!resolutionNote || typeof resolutionNote !== "string") {
      throw new Error("resolutionNote is required");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE provider_quarantines
        SET
          is_active = false,
          resolved_by_owner_id = $6,
          resolved_at = now(),
          resolution_note = $7,
          updated_at = now()
        WHERE owner_id = $1
          AND agent_id = $2
          AND slot = $3
          AND provider = $4
          AND credential_key = $5
          AND is_active = true
        RETURNING *
        `,
        [ownerId, agentId, slot, provider, credentialKey, resolvedByOwnerId, resolutionNote]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async getActiveQuarantines({ ownerId, agentId }) {
    if (!ownerId || !agentId) {
      throw new Error("getActiveQuarantines requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT * FROM provider_quarantines
        WHERE owner_id = $1 AND agent_id = $2 AND is_active = true
        ORDER BY created_at DESC
        `,
        [ownerId, agentId]
      );
      return result.rows;
    } finally {
      await conn.release();
    }
  }
}

export class OwnerAlertsRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("OwnerAlertsRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async createAlert({
    ownerId,
    agentId,
    alertType,
    severity = "warning",
    title,
    message,
    provider,
    credentialKey,
    context
  }) {
    const validTypes = [
      "circuit_breaker_open",
      "provider_quarantine",
      "quota_exhaustion",
      "emergency_pause_triggered",
      "recovery_success",
      "recovery_attempt_failed"
    ];
    if (!validTypes.includes(alertType)) {
      throw new Error(`Invalid alertType: ${alertType}`);
    }
    if (!["info", "warning", "critical"].includes(severity)) {
      throw new Error(`Invalid severity: ${severity}`);
    }
    if (!ownerId || !agentId || !title || !message) {
      throw new Error(
        "createAlert requires ownerId, agentId, title, message"
      );
    }
    if (typeof title !== "string" || title.length < 1 || title.length > 200) {
      throw new Error("title must be 1-200 characters");
    }
    if (typeof message !== "string" || message.length < 1 || message.length > 1000) {
      throw new Error("message must be 1-1000 characters");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO owner_alerts_outbox (
          owner_id, agent_id, alert_type, severity, title, message,
          provider, credential_key, context
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          ownerId,
          agentId,
          alertType,
          severity,
          title,
          message,
          provider || null,
          credentialKey || null,
          JSON.stringify(context || {})
        ]
      );
      return result.rows[0];
    } finally {
      await conn.release();
    }
  }

  async acknowledgeAlert({ ownerId, alertId, acknowledgedByOwnerId }) {
    if (!ownerId || !alertId || !acknowledgedByOwnerId) {
      throw new Error(
        "acknowledgeAlert requires ownerId, alertId, acknowledgedByOwnerId"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE owner_alerts_outbox
        SET
          is_acknowledged = true,
          acknowledged_by_owner_id = $3,
          acknowledged_at = now(),
          updated_at = now()
        WHERE owner_id = $1 AND id = $2 AND is_acknowledged = false
        RETURNING *
        `,
        [ownerId, alertId, acknowledgedByOwnerId]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async resolveAlert({ ownerId, alertId, resolvedByOwnerId }) {
    if (!ownerId || !alertId || !resolvedByOwnerId) {
      throw new Error(
        "resolveAlert requires ownerId, alertId, resolvedByOwnerId"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE owner_alerts_outbox
        SET
          is_resolved = true,
          resolved_by_owner_id = $3,
          resolved_at = now(),
          updated_at = now()
        WHERE owner_id = $1 AND id = $2 AND is_acknowledged = true AND is_resolved = false
        RETURNING *
        `,
        [ownerId, alertId, resolvedByOwnerId]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async getUnacknowledgedAlerts({ ownerId }) {
    if (!ownerId) {
      throw new Error("getUnacknowledgedAlerts requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT * FROM owner_alerts_outbox
        WHERE owner_id = $1 AND is_acknowledged = false
        ORDER BY severity DESC, created_at DESC
        LIMIT 100
        `,
        [ownerId]
      );
      return result.rows;
    } finally {
      await conn.release();
    }
  }

  async getAlerts({ ownerId, limit = 50, offset = 0 }) {
    if (!ownerId) {
      throw new Error("getAlerts requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT * FROM owner_alerts_outbox
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [ownerId, limit, offset]
      );
      return result.rows;
    } finally {
      await conn.release();
    }
  }
}

export class OwnerEmergencyPauseRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("OwnerEmergencyPauseRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async getOrCreatePauseGate({ ownerId }) {
    if (!ownerId) {
      throw new Error("getOrCreatePauseGate requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO owner_emergency_pause_gates (owner_id, is_paused)
        VALUES ($1, false)
        ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
        RETURNING *
        `,
        [ownerId]
      );
      return result.rows[0];
    } finally {
      await conn.release();
    }
  }

  async isPaused({ ownerId }) {
    if (!ownerId) {
      throw new Error("isPaused requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT is_paused FROM owner_emergency_pause_gates
        WHERE owner_id = $1
        `,
        [ownerId]
      );
      return result.rows.length > 0 && result.rows[0].is_paused;
    } finally {
      await conn.release();
    }
  }

  async pause({ ownerId, pausedByOwnerId, pausedReason }) {
    if (!ownerId || !pausedByOwnerId || !pausedReason) {
      throw new Error(
        "pause requires ownerId, pausedByOwnerId, pausedReason"
      );
    }
    if (typeof pausedReason !== "string" || pausedReason.length < 1) {
      throw new Error("pausedReason is required");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE owner_emergency_pause_gates
        SET
          is_paused = true,
          paused_by_owner_id = $2,
          paused_at = now(),
          paused_reason = $3,
          updated_at = now()
        WHERE owner_id = $1 AND is_paused = false
        RETURNING *
        `,
        [ownerId, pausedByOwnerId, pausedReason]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async resume({ ownerId, resumedByOwnerId, resumedReason }) {
    if (!ownerId || !resumedByOwnerId || !resumedReason) {
      throw new Error(
        "resume requires ownerId, resumedByOwnerId, resumedReason"
      );
    }
    if (typeof resumedReason !== "string" || resumedReason.length < 1) {
      throw new Error("resumedReason is required");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE owner_emergency_pause_gates
        SET
          is_paused = false,
          resumed_by_owner_id = $2,
          resumed_at = now(),
          resumed_reason = $3,
          updated_at = now()
        WHERE owner_id = $1 AND is_paused = true
        RETURNING *
        `,
        [ownerId, resumedByOwnerId, resumedReason]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async getPauseStatus({ ownerId }) {
    if (!ownerId) {
      throw new Error("getPauseStatus requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT * FROM owner_emergency_pause_gates WHERE owner_id = $1
        `,
        [ownerId]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }
}

export class DurableCircuitBreakerRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("DurableCircuitBreakerRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async getOrCreateState({
    ownerId,
    agentId,
    slot,
    provider,
    credentialKey
  }) {
    if (!ownerId || !agentId || !slot || !provider || !credentialKey) {
      throw new Error(
        "getOrCreateState requires ownerId, agentId, slot, provider, credentialKey"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO provider_circuit_breaker_state (
          owner_id, agent_id, slot, provider, credential_key
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (owner_id, agent_id, slot, provider, credential_key)
        DO UPDATE SET owner_id = EXCLUDED.owner_id
        RETURNING *
        `,
        [ownerId, agentId, slot, provider, credentialKey]
      );
      return result.rows[0];
    } finally {
      await conn.release();
    }
  }

  async recordSuccess({ ownerId, agentId, slot, provider, credentialKey }) {
    if (!ownerId || !agentId || !slot || !provider || !credentialKey) {
      throw new Error(
        "recordSuccess requires ownerId, agentId, slot, provider, credentialKey"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE provider_circuit_breaker_state
        SET
          consecutive_failures = 0,
          consecutive_successes = consecutive_successes + 1,
          last_success_at = now(),
          state = CASE
            WHEN state = 'half_open' AND consecutive_successes + 1 >= success_threshold_to_close
              THEN 'closed'
            WHEN state = 'half_open'
              THEN 'half_open'
            ELSE state
          END,
          cooldown_until = CASE
            WHEN state = 'half_open' AND consecutive_successes + 1 >= success_threshold_to_close
              THEN NULL
            ELSE cooldown_until
          END,
          updated_at = now()
        WHERE owner_id = $1
          AND agent_id = $2
          AND slot = $3
          AND provider = $4
          AND credential_key = $5
        RETURNING *
        `,
        [ownerId, agentId, slot, provider, credentialKey]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async recordFailure({
    ownerId,
    agentId,
    slot,
    provider,
    credentialKey,
    failureReason
  }) {
    if (!ownerId || !agentId || !slot || !provider || !credentialKey) {
      throw new Error(
        "recordFailure requires ownerId, agentId, slot, provider, credentialKey"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE provider_circuit_breaker_state
        SET
          consecutive_failures = consecutive_failures + 1,
          consecutive_successes = 0,
          last_failure_reason = $6,
          state = CASE
            WHEN state = 'closed' AND consecutive_failures + 1 >= max_consecutive_failures
              THEN 'open'
            WHEN state = 'half_open'
              THEN 'open'
            ELSE state
          END,
          opened_at = CASE
            WHEN state = 'closed' AND consecutive_failures + 1 >= max_consecutive_failures
              THEN now()
            ELSE opened_at
          END,
          cooldown_until = CASE
            WHEN state = 'closed' AND consecutive_failures + 1 >= max_consecutive_failures
              THEN now() + (cooldown_duration_ms || 'ms')::interval
            ELSE cooldown_until
          END,
          updated_at = now()
        WHERE owner_id = $1
          AND agent_id = $2
          AND slot = $3
          AND provider = $4
          AND credential_key = $5
        RETURNING *
        `,
        [ownerId, agentId, slot, provider, credentialKey, failureReason || "unknown"]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async isHealthy({ ownerId, agentId, slot, provider, credentialKey }) {
    if (!ownerId || !agentId || !slot || !provider || !credentialKey) {
      throw new Error(
        "isHealthy requires ownerId, agentId, slot, provider, credentialKey"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT state, cooldown_until FROM provider_circuit_breaker_state
        WHERE owner_id = $1
          AND agent_id = $2
          AND slot = $3
          AND provider = $4
          AND credential_key = $5
          AND enabled = true
        `,
        [ownerId, agentId, slot, provider, credentialKey]
      );
      if (result.rows.length === 0) return true; // No record = healthy
      const { state, cooldown_until } = result.rows[0];
      if (state === "closed") return true;
      if (state === "open" && cooldown_until && new Date(cooldown_until) > new Date()) {
        return false; // Still in cooldown
      }
      if (state === "open" && (!cooldown_until || new Date(cooldown_until) <= new Date())) {
        // Move to HALF_OPEN on next check
        await conn.query(
          `
          UPDATE provider_circuit_breaker_state
          SET state = 'half_open', consecutive_successes = 0
          WHERE owner_id = $1
            AND agent_id = $2
            AND slot = $3
            AND provider = $4
            AND credential_key = $5
          `,
          [ownerId, agentId, slot, provider, credentialKey]
        );
        return true; // Allow half-open test
      }
      return state !== "open";
    } finally {
      await conn.release();
    }
  }
}
