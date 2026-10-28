import { appendEvidenceEventXact } from "../jobs/retry/retryManager.js";

const FAILURE_CODES = new Set(["RATE_LIMIT", "TIMEOUT", "SERVICE_UNAVAILABLE", "TEMPORARY_NETWORK_FAILURE", "POLICY_FAILURE"]);
const QUARANTINE_CODES = new Set(["POLICY_REJECTED", "QUALITY_REJECTED", "SECURITY_REJECTED", "MALFORMED_OUTPUT"]);
const PAUSE_REASONS = new Set(["OWNER_REQUEST", "SECURITY_EVENT", "QUOTA_EXHAUSTED", "RECOVERY_GUARD"]);

function required(value, code, max = 160) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(code);
  if (/token|secret|password|vault:\/\/|bearer/i.test(value)) throw new Error("HOSTILE_OR_SECRET_VALUE_REJECTED");
  return value;
}

function scopeOf(input, targetRequired = true) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("RESILIENCE_SCOPE_REQUIRED");
  const ownerId = required(input.ownerId, "OWNER_ID_REQUIRED", 100);
  const agentId = required(input.agentId, "AGENT_ID_REQUIRED", 200);
  const targetType = input.targetType ?? "operation";
  if (!new Set(["provider", "operation"]).has(targetType)) throw new Error("INVALID_CIRCUIT_TARGET_TYPE");
  const targetKey = targetRequired ? required(input.targetKey, "TARGET_KEY_REQUIRED", 120) : input.targetKey;
  return { ownerId, agentId, targetType, targetKey };
}

function circuitDto(row) {
  return { id: row.id, ownerId: row.owner_id, agentId: row.agent_id, targetType: row.target_type,
    targetKey: row.target_key, state: row.state, failureCount: Number(row.failure_count),
    threshold: Number(row.failure_threshold), openedUntil: row.opened_until ? new Date(row.opened_until).toISOString() : null,
    failureCode: row.failure_code };
}

export class PostgresResilienceRepository {
  constructor(adapter) {
    if (!adapter || typeof adapter.withTransaction !== "function") throw new Error("POSTGRES_TRANSACTION_ADAPTER_REQUIRED");
    this.adapter = adapter;
    this.isProductionDurable = true;
  }

  async recordFailure(scope, { failureCode, threshold = 3, cooldownSeconds = 60 } = {}) {
    const s = scopeOf(scope);
    if (!FAILURE_CODES.has(failureCode)) throw new Error("UNKNOWN_FAILURE_CLASSIFICATION");
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100) throw new Error("INVALID_FAILURE_THRESHOLD");
    if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 1 || cooldownSeconds > 3600) throw new Error("INVALID_CIRCUIT_COOLDOWN");
    return this.adapter.withTransaction(async (client) => {
      await client.query(`INSERT INTO resilience_circuits
        (owner_id,agent_id,target_type,target_key,failure_threshold)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [s.ownerId,s.agentId,s.targetType,s.targetKey,threshold]);
      const locked = await client.query(`SELECT * FROM resilience_circuits
        WHERE owner_id=$1 AND agent_id=$2 AND target_type=$3 AND target_key=$4 FOR UPDATE`,
        [s.ownerId,s.agentId,s.targetType,s.targetKey]);
      if (locked.rowCount !== 1) throw new Error("CIRCUIT_SCOPE_MISMATCH");
      const nextCount = Number(locked.rows[0].failure_count) + 1;
      const shouldOpen = nextCount >= Number(locked.rows[0].failure_threshold) || locked.rows[0].state === "half_open";
      const updated = await client.query(`UPDATE resilience_circuits SET
        failure_count=$2, state=CASE WHEN $3 THEN 'open' ELSE state END,
        opened_until=CASE WHEN $3 THEN now()+($4*interval '1 second') ELSE opened_until END,
        probe_claimed_at=NULL, failure_code=$5, updated_at=now() WHERE id=$1 RETURNING *`,
        [locked.rows[0].id,nextCount,shouldOpen,cooldownSeconds,failureCode]);
      const dto = circuitDto(updated.rows[0]);
      if (shouldOpen) await this.#insertAlert(client, s, "critical", "CIRCUIT_OPEN", `circuit:${dto.id}:${dto.openedUntil}`, dto.id);
      await appendEvidenceEventXact(client,{subjectId:dto.id,kind:"resilience_circuit_failure",classification:"bounded_circuit_transition",
        payload:{ownerId:s.ownerId,agentId:s.agentId,targetType:s.targetType,targetKey:s.targetKey,state:dto.state,failureCode}});
      return dto;
    });
  }

  async claimHalfOpenProbe(scope) {
    const s = scopeOf(scope);
    return this.adapter.withTransaction(async (client) => {
      const result = await client.query(`UPDATE resilience_circuits SET state='half_open',probe_claimed_at=now(),updated_at=now()
        WHERE owner_id=$1 AND agent_id=$2 AND target_type=$3 AND target_key=$4
          AND state='open' AND opened_until <= now() RETURNING *`, [s.ownerId,s.agentId,s.targetType,s.targetKey]);
      if (result.rowCount !== 1) throw new Error("CIRCUIT_PROBE_DENIED");
      const dto=circuitDto(result.rows[0]);
      await appendEvidenceEventXact(client,{subjectId:dto.id,kind:"resilience_probe_claimed",classification:"atomic_half_open_probe",
        payload:{ownerId:s.ownerId,agentId:s.agentId,targetType:s.targetType,targetKey:s.targetKey,state:"half_open"}});
      return dto;
    });
  }

  async recordSuccess(scope) {
    const s=scopeOf(scope);
    return this.adapter.withTransaction(async(client)=>{
      const result=await client.query(`UPDATE resilience_circuits SET state='closed',failure_count=0,opened_until=NULL,
        probe_claimed_at=NULL,failure_code=NULL,updated_at=now() WHERE owner_id=$1 AND agent_id=$2 AND target_type=$3 AND target_key=$4 RETURNING *`,
        [s.ownerId,s.agentId,s.targetType,s.targetKey]);
      if(result.rowCount!==1) throw new Error("CIRCUIT_SCOPE_MISMATCH");
      const dto=circuitDto(result.rows[0]);
      await appendEvidenceEventXact(client,{subjectId:dto.id,kind:"resilience_circuit_closed",classification:"successful_probe",
        payload:{ownerId:s.ownerId,agentId:s.agentId,targetType:s.targetType,targetKey:s.targetKey,state:"closed"}});
      return dto;
    });
  }

  async quarantine(scope,{operation,contentSha256,classification,metadata={}}={}) {
    const s=scopeOf(scope,false);
    operation=required(operation,"OPERATION_REQUIRED",120);
    if(typeof contentSha256!=="string"||!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error("INVALID_CONTENT_HASH");
    if(!QUARANTINE_CODES.has(classification)) throw new Error("UNKNOWN_QUARANTINE_CLASSIFICATION");
    const clean={};
    for(const key of ["artifactKind","policyCode","qualityGate"]){if(typeof metadata[key]==="string") clean[key]=required(metadata[key],"HOSTILE_QUARANTINE_METADATA",160);}
    return this.adapter.withTransaction(async(client)=>{
      const result=await client.query(`INSERT INTO quarantine_records(owner_id,agent_id,operation,content_sha256,classification,metadata)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,agent_id,operation,content_sha256) DO NOTHING RETURNING *`,
        [s.ownerId,s.agentId,operation,contentSha256,classification,JSON.stringify(clean)]);
      if(result.rowCount!==1) throw new Error("OUTPUT_ALREADY_QUARANTINED");
      const row=result.rows[0];
      await this.#insertAlert(client,s,"warning","OUTPUT_QUARANTINED",`quarantine:${row.id}`,row.id);
      await appendEvidenceEventXact(client,{subjectId:row.id,kind:"output_quarantined",classification:"immutable_quarantine",
        payload:{ownerId:s.ownerId,agentId:s.agentId,operation,contentSha256,quarantineCode:classification}});
      return {id:row.id,ownerId:s.ownerId,agentId:s.agentId,operation,contentSha256,classification,metadata:clean};
    });
  }

  async authorizeQuarantineAction(scope,{quarantineId,action,approvalId,authorizedOwnerId}={}){
    const s=scopeOf(scope,false);
    required(quarantineId,"QUARANTINE_ID_REQUIRED",100); required(approvalId,"APPROVAL_ID_REQUIRED",160);
    if(authorizedOwnerId!==s.ownerId) throw new Error("OWNER_AUTHORIZATION_REQUIRED");
    if(!new Set(["release","retry"]).has(action)) throw new Error("INVALID_QUARANTINE_ACTION");
    return this.adapter.withTransaction(async(client)=>{
      const q=await client.query(`SELECT id FROM quarantine_records WHERE id=$1 AND owner_id=$2 AND agent_id=$3`,[quarantineId,s.ownerId,s.agentId]);
      if(q.rowCount!==1) throw new Error("QUARANTINE_SCOPE_MISMATCH");
      const result=await client.query(`INSERT INTO quarantine_actions(quarantine_id,owner_id,agent_id,action,approval_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id,created_at`,[quarantineId,s.ownerId,s.agentId,action,approvalId]);
      if(result.rowCount!==1) throw new Error("QUARANTINE_ACTION_ALREADY_RECORDED");
      await appendEvidenceEventXact(client,{subjectId:quarantineId,kind:"quarantine_action_authorized",classification:"owner_authorized_recovery",
        payload:{ownerId:s.ownerId,agentId:s.agentId,action,approvalId}});
      return {id:result.rows[0].id,quarantineId,action,approvalId};
    });
  }

  async setPause({ownerId,agentId=null,scopeType,operation=null},{reasonCode,approvalId,authorizedOwnerId}={}){
    ownerId=required(ownerId,"OWNER_ID_REQUIRED",100); approvalId=required(approvalId,"APPROVAL_ID_REQUIRED",160);
    if(authorizedOwnerId!==ownerId) throw new Error("OWNER_AUTHORIZATION_REQUIRED");
    if(!PAUSE_REASONS.has(reasonCode)) throw new Error("INVALID_PAUSE_REASON");
    if(!new Set(["global_owner","agent","operation"]).has(scopeType)) throw new Error("INVALID_PAUSE_SCOPE");
    if(scopeType!=="global_owner") agentId=required(agentId,"AGENT_ID_REQUIRED",200); else agentId=null;
    if(scopeType==="operation") operation=required(operation,"OPERATION_REQUIRED",120); else operation=null;
    return this.adapter.withTransaction(async(client)=>{
      const result=await client.query(`INSERT INTO emergency_pauses(owner_id,agent_id,scope_type,operation,reason_code,approval_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[ownerId,agentId,scopeType,operation,reasonCode,approvalId]);
      const row=result.rows[0];
      await appendEvidenceEventXact(client,{subjectId:row.id,kind:"emergency_pause_set",classification:"owner_authorized_pause",
        payload:{ownerId,agentId,scopeType,operation,reasonCode,approvalId}});
      return {id:row.id,ownerId,agentId,scopeType,operation,reasonCode,active:true};
    });
  }

  async clearPause({ownerId,pauseId},{approvalId,authorizedOwnerId}={}){
    ownerId=required(ownerId,"OWNER_ID_REQUIRED",100); required(pauseId,"PAUSE_ID_REQUIRED",100); required(approvalId,"APPROVAL_ID_REQUIRED",160);
    if(authorizedOwnerId!==ownerId) throw new Error("OWNER_AUTHORIZATION_REQUIRED");
    return this.adapter.withTransaction(async(client)=>{
      const result=await client.query(`UPDATE emergency_pauses SET active=false,cleared_at=now()
        WHERE id=$1 AND owner_id=$2 AND active RETURNING *`,[pauseId,ownerId]);
      if(result.rowCount!==1) throw new Error("PAUSE_SCOPE_MISMATCH_OR_INACTIVE");
      await appendEvidenceEventXact(client,{subjectId:pauseId,kind:"emergency_pause_cleared",classification:"owner_authorized_recovery",
        payload:{ownerId,agentId:result.rows[0].agent_id,scopeType:result.rows[0].scope_type,operation:result.rows[0].operation,approvalId}});
      return {id:pauseId,active:false};
    });
  }

  async assertWorkAllowed({ownerId,agentId,operation}){
    ownerId=required(ownerId,"OWNER_ID_REQUIRED",100); agentId=required(agentId,"AGENT_ID_REQUIRED",200); operation=required(operation,"OPERATION_REQUIRED",120);
    const result=await this.adapter.query(`SELECT id,scope_type,reason_code FROM emergency_pauses WHERE owner_id=$1 AND active
      AND (scope_type='global_owner' OR (agent_id=$2 AND scope_type='agent') OR (agent_id=$2 AND scope_type='operation' AND operation=$3))
      ORDER BY CASE scope_type WHEN 'global_owner' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END LIMIT 1`,[ownerId,agentId,operation]);
    if(result.rowCount) { const e=new Error("EMERGENCY_PAUSE_ACTIVE"); e.pause={id:result.rows[0].id,scopeType:result.rows[0].scope_type,reasonCode:result.rows[0].reason_code}; throw e; }
    return true;
  }

  async acknowledgeAlert({ownerId,agentId,alertId},{authorizedOwnerId}={}){
    ownerId=required(ownerId,"OWNER_ID_REQUIRED",100);agentId=required(agentId,"AGENT_ID_REQUIRED",200);required(alertId,"ALERT_ID_REQUIRED",100);
    if(authorizedOwnerId!==ownerId) throw new Error("OWNER_AUTHORIZATION_REQUIRED");
    return this.adapter.withTransaction(async(client)=>{
      const result=await client.query(`UPDATE owner_alerts SET acknowledged_at=COALESCE(acknowledged_at,now())
        WHERE id=$1 AND owner_id=$2 AND agent_id=$3 RETURNING *`,[alertId,ownerId,agentId]);
      if(result.rowCount!==1) throw new Error("ALERT_SCOPE_MISMATCH");
      await appendEvidenceEventXact(client,{subjectId:alertId,kind:"owner_alert_acknowledged",classification:"owner_acknowledgement",
        payload:{ownerId,agentId,alertCode:result.rows[0].alert_code}});
      return {id:alertId,acknowledgedAt:new Date(result.rows[0].acknowledged_at).toISOString()};
    });
  }

  async #insertAlert(client,s,severity,alertCode,dedupeKey,subjectId){
    await client.query(`INSERT INTO owner_alerts(owner_id,agent_id,severity,alert_code,dedupe_key,subject_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,agent_id,dedupe_key) DO NOTHING`,
      [s.ownerId,s.agentId,severity,alertCode,dedupeKey,subjectId]);
  }
}
