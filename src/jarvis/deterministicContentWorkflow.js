import crypto from "node:crypto";

const JARVIS_AGENT_ID = "agent-01";
const ALLOWED_LANGUAGES = new Set(["hindi", "hinglish"]);

function boundedText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (/password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\//i.test(normalized)) throw new Error("JARVIS_BRIEF_SECRET_REJECTED");
  return normalized;
}

function stableId(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function deterministicJarvisContentHandler(ctx) {
  if (ctx.agentId !== JARVIS_AGENT_ID || ctx.jobType !== "jarvis.content.outline.v1") {
    throw new Error("JARVIS_WORKFLOW_SCOPE_MISMATCH");
  }
  const publicBrand = boundedText(ctx.payload.publicBrand, "JARVIS_PUBLIC_BRAND_INVALID", 2, 80);
  const concept = boundedText(ctx.payload.concept, "JARVIS_CONCEPT_INVALID", 20, 1200);
  const language = String(ctx.payload.language || "").toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) throw new Error("JARVIS_LANGUAGE_UNSUPPORTED");
  const targetMinutes = Number(ctx.payload.targetMinutes);
  if (!Number.isInteger(targetMinutes) || targetMinutes < 25 || targetMinutes > 30) {
    throw new Error("JARVIS_TARGET_DURATION_INVALID");
  }

  ctx.heartbeat("brief_validated", 10, { generationMode: "deterministic_local" });
  await ctx.checkpoint("brief_validated", 10, { generationMode: "deterministic_local", language, targetMinutes });

  const packageId = stableId({ publicBrand, concept, language, targetMinutes });
  const storyOutline = Object.freeze([
    { beat: "hook", purpose: "Open with an immediate unsettling event grounded in the supplied concept." },
    { beat: "discovery", purpose: "Reveal the local mystery without explaining its supernatural cause." },
    { beat: "escalation", purpose: "Increase danger, emotional pressure, and uncertainty." },
    { beat: "reversal", purpose: "Introduce a fair but surprising change in what the audience believes." },
    { beat: "cliffhanger", purpose: "End with unresolved danger without revealing the final truth." },
  ]);
  await ctx.checkpoint("outline_created", 70, { packageId, beatCount: storyOutline.length });

  const contentPackage = {
    schemaVersion: 1,
    packageId,
    packageType: "jarvis_mvp_story_outline",
    readiness: "outline_only",
    generationMode: "deterministic_local",
    publicBrand,
    language,
    targetMinutes,
    suppliedConcept: concept,
    storyOutline,
    shortsPlan: ["opening_hook", "high_tension_moment", "cliffhanger_teaser"],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
  };
  await ctx.checkpoint("outline_package_ready", 100, { packageId, readiness: "outline_only" });
  return contentPackage;
}
