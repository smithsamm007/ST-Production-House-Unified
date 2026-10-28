import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { WorkEnvelope } from "../workers/workEnvelope.js";

const LONG_BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const SHORT_ROLES = Object.freeze(["opening_hook", "high_tension_moment", "cliffhanger_teaser"]);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator/i;
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeText(value, code, min = 1, max = 1200) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("VISUAL_DISPATCH_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw new Error("VISUAL_DISPATCH_INTERNAL_AGENT_NAME_REJECTED");
  return normalized;
}

function validateFrame(frame, expected) {
  if (!frame || frame.aspectRatio !== expected.aspectRatio ||
      frame.width !== expected.width || frame.height !== expected.height) {
    throw new Error("VISUAL_DISPATCH_FRAME_INVALID");
  }
  return { ...expected };
}

function validateVisualPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("VISUAL_DISPATCH_SOURCE_INVALID");
  if (SECRET_LIKE.test(JSON.stringify(plan))) throw new Error("VISUAL_DISPATCH_SECRET_REJECTED");
  if (plan.schemaVersion !== 1 || plan.packageType !== "visual_scene_plan_v1" ||
      plan.readiness !== "scene_plan_only" || plan.generationMode !== "deterministic_local") {
    throw new Error("VISUAL_DISPATCH_SOURCE_CONTRACT_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(plan.planId || "") || !/^[a-f0-9]{64}$/.test(plan.sourcePackageId || "")) {
    throw new Error("VISUAL_DISPATCH_SOURCE_ID_INVALID");
  }
  if (!Array.isArray(plan.providerCalls) || plan.providerCalls.length !== 0 ||
      !Array.isArray(plan.generatedMedia) || plan.generatedMedia.length !== 0) {
    throw new Error("VISUAL_DISPATCH_SOURCE_SIDE_EFFECT_INVALID");
  }
  if (plan.publication?.requested !== false || plan.publication?.status !== "not_requested") {
    throw new Error("VISUAL_DISPATCH_SOURCE_PUBLICATION_INVALID");
  }
  const publicBrand = safeText(plan.publicBrand, "VISUAL_DISPATCH_PUBLIC_BRAND_INVALID", 2, 80);
  if (!Array.isArray(plan.longFormScenes) || plan.longFormScenes.length !== LONG_BEATS.length) {
    throw new Error("VISUAL_DISPATCH_LONG_SCENES_INVALID");
  }
  const longFormScenes = plan.longFormScenes.map((scene, index) => {
    if (!scene || scene.sceneNumber !== index + 1 || scene.beat !== LONG_BEATS[index]) {
      throw new Error("VISUAL_DISPATCH_LONG_SCENES_INVALID");
    }
    if (scene.visualSafety?.sourceMaterial !== "owner_supplied_concept_only" ||
        scene.visualSafety?.requireOriginalComposition !== true ||
        scene.visualSafety?.protectedCharacterImitation !== false) {
      throw new Error("VISUAL_DISPATCH_SAFETY_INVALID");
    }
    return {
      sceneNumber: scene.sceneNumber,
      beat: scene.beat,
      purpose: safeText(scene.purpose, "VISUAL_DISPATCH_PURPOSE_INVALID", 10, 300),
      frame: validateFrame(scene.frame, { aspectRatio: "16:9", width: 1920, height: 1080 }),
      visualSafety: { ...scene.visualSafety },
    };
  });
  if (!Array.isArray(plan.shortsScenes) || plan.shortsScenes.length !== SHORT_ROLES.length) {
    throw new Error("VISUAL_DISPATCH_SHORT_SCENES_INVALID");
  }
  const shortsScenes = plan.shortsScenes.map((scene, index) => {
    if (!scene || scene.sceneNumber !== index + 1 || scene.role !== SHORT_ROLES[index]) {
      throw new Error("VISUAL_DISPATCH_SHORT_SCENES_INVALID");
    }
    if (scene.role === "cliffhanger_teaser" && scene.endingDisclosure !== "ending_not_revealed") {
      throw new Error("VISUAL_DISPATCH_ENDING_REVEAL_INVALID");
    }
    return {
      sceneNumber: scene.sceneNumber,
      role: scene.role,
      frame: validateFrame(scene.frame, { aspectRatio: "9:16", width: 1080, height: 1920 }),
      endingDisclosure: scene.endingDisclosure,
    };
  });
  return { publicBrand, longFormScenes, shortsScenes };
}

function dispatchEnvelope(plan, publicBrand, lane, scene) {
  const taskId = stableId({ sourcePlanId: plan.planId, lane, scene });
  return new WorkEnvelope({
    taskId,
    jobType: "media.image.generate.v1",
    agentId: "agent-01",
    payload: {
      schemaVersion: 1,
      capability: "image_generation",
      dispatchStatus: "ready_for_quota_check",
      publicBrand,
      sourcePlanId: plan.planId,
      lane,
      scene,
    },
    context: {
      sourcePackageId: plan.sourcePackageId,
      executionRequested: false,
      providerSelection: "not_performed",
    },
  });
}

export function createDeterministicVisualDispatch(plan) {
  const validated = validateVisualPlan(plan);
  const dispatchRequests = [
    ...validated.longFormScenes.map((scene) => dispatchEnvelope(plan, validated.publicBrand, "long_form", scene)),
    ...validated.shortsScenes.map((scene) => dispatchEnvelope(plan, validated.publicBrand, "short", scene)),
  ];
  return {
    schemaVersion: 1,
    packageId: stableId({ sourcePlanId: plan.planId, taskIds: dispatchRequests.map(({ taskId }) => taskId) }),
    packageType: "visual_dispatch_v1",
    sourcePlanId: plan.planId,
    readiness: "dispatch_ready_only",
    capability: "image_generation",
    generationMode: "deterministic_local",
    dispatchRequests,
    providerSelection: "not_performed",
    providerCalls: [],
    credentials: [],
    artifacts: [],
    evidence: [],
    publication: { requested: false, status: "not_requested" },
  };
}

export function createWaitingForQuotaState(dispatchPackage) {
  if (!dispatchPackage || dispatchPackage.packageType !== "visual_dispatch_v1" ||
      dispatchPackage.readiness !== "dispatch_ready_only" || !/^[a-f0-9]{64}$/.test(dispatchPackage.packageId || "")) {
    throw new Error("VISUAL_DISPATCH_WAIT_SOURCE_INVALID");
  }
  if (!Array.isArray(dispatchPackage.providerCalls) || dispatchPackage.providerCalls.length !== 0 ||
      !Array.isArray(dispatchPackage.artifacts) || dispatchPackage.artifacts.length !== 0 ||
      dispatchPackage.publication?.status !== "not_requested") {
    throw new Error("VISUAL_DISPATCH_WAIT_SIDE_EFFECT_INVALID");
  }
  return {
    schemaVersion: 1,
    stateId: stableId({ dispatchPackageId: dispatchPackage.packageId, state: "WAITING_FOR_QUOTA" }),
    dispatchPackageId: dispatchPackage.packageId,
    state: "WAITING_FOR_QUOTA",
    reason: "APPROVED_FREE_CAPACITY_UNAVAILABLE",
    resumePolicy: "retry_after_capacity_signal",
    checkpoint: {
      step: "waiting_for_quota",
      progress: 0,
      persistenceStatus: "not_persisted",
    },
    providerCalls: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
  };
}

