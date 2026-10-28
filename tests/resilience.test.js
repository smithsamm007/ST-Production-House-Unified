import test from "node:test";
import assert from "node:assert/strict";
import { PostgresResilienceRepository } from "../src/resilience/postgresResilienceRepository.js";

const adapter={withTransaction:async()=>{},query:async()=>{}};

test("Task 3.7 rejects unknown classifications and hostile scope values before persistence",async()=>{
  const repo=new PostgresResilienceRepository(adapter);
  await assert.rejects(repo.recordFailure({ownerId:"owner",agentId:"agent",targetType:"provider",targetKey:"p"},{failureCode:"UNKNOWN"}),/UNKNOWN_FAILURE_CLASSIFICATION/);
  await assert.rejects(repo.recordFailure({ownerId:"owner",agentId:"agent",targetType:"provider",targetKey:"vault:\/\/secret"},{failureCode:"TIMEOUT"}),/HOSTILE_OR_SECRET/);
  await assert.rejects(repo.quarantine({ownerId:"owner",agentId:"agent"},{operation:"render",contentSha256:"raw-output",classification:"POLICY_REJECTED"}),/INVALID_CONTENT_HASH/);
  await assert.rejects(repo.setPause({ownerId:"owner",scopeType:"global_owner"},{reasonCode:"OWNER_REQUEST",approvalId:"a",authorizedOwnerId:"other"}),/OWNER_AUTHORIZATION_REQUIRED/);
});
