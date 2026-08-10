import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresResilienceRepository } from "../src/resilience/postgresResilienceRepository.js";

test("Task 3.7 PostgreSQL 15 resilience acceptance",async(t)=>{
  const dbUrl=process.env.POSTGRES_TEST_URL||process.env.DATABASE_URL;
  const required=Boolean(process.env.CI||process.env.npm_lifecycle_event==="test:integration"||dbUrl);
  if(!dbUrl){if(required) assert.fail("PostgreSQL 15 URL is mandatory for Task 3.7 integration acceptance");t.diagnostic("PostgreSQL is not configured; live Task 3.7 suite is not run by unit command");return;}
  const schema=`resilience_${process.pid}_${Date.now()}`;const connection={connectionString:dbUrl,connectionTimeoutMillis:5000};
  const bootstrap=new pg.Pool(connection);let pool;
  try{
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({...connection,options:`-c search_path=${schema},public`});
    const adapter=new PostgresAdapter({},pool);const runner=new MigrationRunner(adapter);await runner.runMigrations();assert.equal((await runner.runMigrations()).appliedCount,0);
    const ownerId=crypto.randomUUID(),otherOwnerId=crypto.randomUUID(),agentId=`res-agent-${Date.now()}`;
    await adapter.query(`INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x'),($3,$4,'x')`,[ownerId,`${ownerId}@test.invalid`,otherOwnerId,`${otherOwnerId}@test.invalid`]);
    await adapter.query(`INSERT INTO agents(id,name,namespace) VALUES($1,$2,$3)`,[agentId,`RES_${Date.now()}`,`st.res.${Date.now()}`]);
    const repo=new PostgresResilienceRepository(adapter);const scope={ownerId,agentId,targetType:"provider",targetKey:"provider-a"};
    await repo.recordFailure(scope,{failureCode:"TIMEOUT",threshold:1,cooldownSeconds:1});
    await assert.rejects(repo.claimHalfOpenProbe(scope),/CIRCUIT_PROBE_DENIED/);
    await adapter.query(`UPDATE resilience_circuits SET opened_until=now()-interval '1 second' WHERE owner_id=$1 AND agent_id=$2`,[ownerId,agentId]);
    const probes=await Promise.allSettled([repo.claimHalfOpenProbe(scope),repo.claimHalfOpenProbe(scope)]);assert.equal(probes.filter(x=>x.status==="fulfilled").length,1);
    await repo.recordSuccess(scope);assert.equal((await adapter.query(`SELECT state FROM resilience_circuits WHERE owner_id=$1`,[ownerId])).rows[0].state,"closed");

    const contentSha256=crypto.createHash("sha256").update("rejected-output").digest("hex");
    const q=await repo.quarantine({ownerId,agentId},{operation:"render",contentSha256,classification:"POLICY_REJECTED",metadata:{artifactKind:"video"}});
    await assert.rejects(repo.authorizeQuarantineAction({ownerId,agentId},{quarantineId:q.id,action:"release",approvalId:"approval-1",authorizedOwnerId:otherOwnerId}),/OWNER_AUTHORIZATION_REQUIRED/);
    await repo.authorizeQuarantineAction({ownerId,agentId},{quarantineId:q.id,action:"release",approvalId:"approval-1",authorizedOwnerId:ownerId});
    await assert.rejects(adapter.query(`UPDATE quarantine_records SET classification='QUALITY_REJECTED' WHERE id=$1`,[q.id]),/QUARANTINE_RECORDS_ARE_IMMUTABLE/);

    const pause=await repo.setPause({ownerId,scopeType:"global_owner"},{reasonCode:"OWNER_REQUEST",approvalId:"pause-1",authorizedOwnerId:ownerId});
    await assert.rejects(repo.assertWorkAllowed({ownerId,agentId,operation:"render"}),/EMERGENCY_PAUSE_ACTIVE/);
    await repo.clearPause({ownerId,pauseId:pause.id},{approvalId:"clear-1",authorizedOwnerId:ownerId});assert.equal(await repo.assertWorkAllowed({ownerId,agentId,operation:"render"}),true);

    const alert=(await adapter.query(`SELECT id FROM owner_alerts WHERE owner_id=$1 AND agent_id=$2 LIMIT 1`,[ownerId,agentId])).rows[0];
    await assert.rejects(repo.acknowledgeAlert({ownerId:otherOwnerId,agentId,alertId:alert.id},{authorizedOwnerId:otherOwnerId}),/ALERT_SCOPE_MISMATCH/);

    await adapter.query(`CREATE FUNCTION reject_resilience_evidence() RETURNS trigger AS $$ BEGIN IF NEW.kind='resilience_circuit_failure' THEN RAISE EXCEPTION 'INJECTED_EVIDENCE_FAILURE'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_resilience_evidence_trigger BEFORE INSERT ON evidence_events FOR EACH ROW EXECUTE FUNCTION reject_resilience_evidence()`);
    const rollbackScope={ownerId,agentId,targetType:"operation",targetKey:"rollback"};
    await assert.rejects(repo.recordFailure(rollbackScope,{failureCode:"TIMEOUT",threshold:1}),/INJECTED_EVIDENCE_FAILURE/);
    assert.equal((await adapter.query(`SELECT count(*)::int count FROM resilience_circuits WHERE target_key='rollback'`)).rows[0].count,0);
    await adapter.closePool();pool=null;
  }finally{if(pool)await pool.end().catch(()=>{});await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await bootstrap.end();}
});
