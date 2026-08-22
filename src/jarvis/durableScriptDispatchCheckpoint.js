const AGENT_ID = "agent-01";
function validateStore(store) { if (!store || typeof store.write !== "function" || typeof store.resume !== "function") throw new Error("SCRIPT_DISPATCH_DURABLE_CHECKPOINT_STORE_REQUIRED"); }
function validateRequest(request, ownerId) {
  if (!request || request.agentId !== AGENT_ID || request.context?.ownerId !== ownerId || request.context?.capacityPolicy !== "approved_free_only" || request.payload?.readiness !== "dispatch_ready_only" || request.payload?.capability !== "text_generation" || !/^dispatch-[a-f0-9]{64}$/.test(request.taskId || "")) throw new Error("SCRIPT_DISPATCH_DURABLE_SCOPE_MISMATCH");
  if (/vault:\/\/|opaque:\/\/|password|api[_ -]?key|bearer\s/i.test(JSON.stringify(request))) throw new Error("SCRIPT_DISPATCH_DURABLE_SECRET_REJECTED");
}
export async function persistScriptWaitingForQuota({ checkpointStore, ownerId, dispatchRequest }) {
  validateStore(checkpointStore); validateRequest(dispatchRequest, ownerId);
  return checkpointStore.write(dispatchRequest.taskId, { step: "script_dispatch_waiting_for_quota", progress: 0, data: { schemaVersion: 1, state: "WAITING_FOR_QUOTA", reasonCode: "APPROVED_FREE_CAPACITY_UNAVAILABLE", resumable: true, executionStarted: false, ownerId, agentId: AGENT_ID, capability: "text_generation", sourcePlanId: dispatchRequest.payload.sourcePlanId, dispatchId: dispatchRequest.payload.dispatchId, capacityPolicy: "approved_free_only", providerSelection: "not_performed" } });
}
export async function resumeScriptDispatch({ checkpointStore, ownerId, dispatchRequest }) {
  validateStore(checkpointStore); validateRequest(dispatchRequest, ownerId); const checkpoint = await checkpointStore.resume(dispatchRequest.taskId); if (!checkpoint) return null;
  if (checkpoint.data?.ownerId !== ownerId || checkpoint.data?.agentId !== AGENT_ID || checkpoint.data?.sourcePlanId !== dispatchRequest.payload.sourcePlanId || checkpoint.data?.dispatchId !== dispatchRequest.payload.dispatchId) throw new Error("SCRIPT_DISPATCH_DURABLE_CHECKPOINT_SCOPE_MISMATCH");
  return checkpoint;
}
