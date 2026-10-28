/**
 * ST Production House — AI News deterministic editorial plan planner.
 *
 * Converts ONE verified, provenance-first research brief (from
 * `deterministicResearchBrief.js`) into a bounded editorial PLAN for a
 * short news explainer. The plan is structural only:
 *
 * - It selects which verified claims are presented in which order.
 * - It drafts section roles (hook, body, caveat, CTA) with per-section
 *   provenance references and generation guidance.
 * - It NEVER writes narration text. No story, sentence, or media is
 *   generated here. `generatedNarrative` stays null and
 *   `generatedMediaCount` stays 0. Real narration requires an approved
 *   free provider (quota-gated) or owner-supplied input in a later slice.
 *
 * Truthfulness rules:
 * - Only `corroborated` claims from a brief with `readiness ===
 *   "ready_for_editorial_review"` may be used. A brief that is
 *   `insufficient_corroboration` produces a truthful BLOCKED result —
 *   never a plan built on unverified claims.
 * - `contradictionFlags` present on the brief block planning entirely:
 *   numeric divergence is surfaced to the owner, never silently resolved.
 * - Deterministic: identical inputs produce the identical plan (SHA-256).
 * - Rule 15: internal agent names are rejected in public text fields.
 * - Rule 17: secret-like inputs are rejected.
 */

import { createHash } from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SCHEMA_VERSION = 1;
const PLAN_TYPE = "ai_news_editorial_plan";
const AGENT_ID = "agent-ai-news";
const SOURCE_BRIEF_TYPE = "ai_news_research_brief";

const MAX_SUPPORTING_CLAIMS = 12;
const MAX_PAYLOAD_BYTES = 262144;

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|client[_ -]?secret)/i;
const INTERNAL_AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);
const URL_LIKE = /(?:https?:\/\/|www\.|javascript:|data:)/i;

const LANGUAGES = Object.freeze(new Set(["hindi", "hinglish", "english"]));
const TONES = Object.freeze(new Set(["factual", "explainer", "urgent", "measured"]));
const SUPPORTED_FORMATS = Object.freeze(new Set(["explainer_short", "explainer_standard", "news_recap"]));

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateEditorialText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("EDITORIAL_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME_PATTERN.test(normalized)) throw new Error("EDITORIAL_PLAN_INTERNAL_NAME_REJECTED");
  if (URL_LIKE.test(normalized)) throw new Error("EDITORIAL_PLAN_URL_REJECTED");
  return normalized;
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("EDITORIAL_PLAN_INPUT_INVALID");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error("EDITORIAL_PLAN_SCHEMA_UNSUPPORTED");

  const payloadJson = JSON.stringify(input);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) throw new Error("EDITORIAL_PLAN_PAYLOAD_TOO_LARGE");
  if (SECRET_LIKE.test(payloadJson)) throw new Error("EDITORIAL_PLAN_SECRET_REJECTED");

  const publicBrand = validateEditorialText(input.publicBrand, "EDITORIAL_PLAN_PUBLIC_BRAND_INVALID", 2, 80);
  const language = String(input.language || "").toLowerCase();
  if (!LANGUAGES.has(language)) throw new Error("EDITORIAL_PLAN_LANGUAGE_UNSUPPORTED");
  const tone = String(input.tone || "").toLowerCase();
  if (!TONES.has(tone)) throw new Error("EDITORIAL_PLAN_TONE_UNSUPPORTED");
  const format = String(input.format || "").toLowerCase();
  if (!SUPPORTED_FORMATS.has(format)) throw new Error("EDITORIAL_PLAN_FORMAT_UNSUPPORTED");
  if (!Number.isInteger(input.targetSeconds) || input.targetSeconds < 45 || input.targetSeconds > 600) {
    throw new Error("EDITORIAL_PLAN_TARGET_SECONDS_INVALID");
  }

  const brief = input.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("EDITORIAL_PLAN_BRIEF_INVALID");
  }
  if (brief.schemaVersion !== 1 || brief.briefType !== SOURCE_BRIEF_TYPE) {
    throw new Error("EDITORIAL_PLAN_BRIEF_CONTRACT_MISMATCH");
  }
  if (brief.generationMode !== "deterministic_local" || brief.provenance?.providerCalls !== 0) {
    throw new Error("EDITORIAL_PLAN_BRIEF_NOT_LOCAL");
  }
  if (typeof brief.briefId !== "string" || !/^[a-f0-9]{64}$/.test(brief.briefId)) {
    throw new Error("EDITORIAL_PLAN_BRIEF_ID_INVALID");
  }

  // Scope echo: the editorial plan must carry the SAME owner/agent scope as
  // the brief it consumes (single-agent isolation; no scope drift).
  if (input.ownerId !== undefined && input.ownerId !== brief.scope?.ownerId) {
    throw new Error("EDITORIAL_PLAN_SCOPE_MISMATCH");
  }
  if (brief.scope?.agentId !== AGENT_ID) {
    throw new Error("EDITORIAL_PLAN_AGENT_MISMATCH");
  }

  return { publicBrand, language, tone, format, targetSeconds: input.targetSeconds, brief };
}

function validateReadyBrief(brief) {
  if (brief.readiness !== "ready_for_editorial_review") {
    return { blocked: true, reasonCode: "BRIEF_INSUFFICIENT_CORROBORATION" };
  }
  if (Array.isArray(brief.contradictionFlags) && brief.contradictionFlags.length > 0) {
    return { blocked: true, reasonCode: "BRIEF_CONTRADICTIONS_UNRESOLVED" };
  }
  if (!Array.isArray(brief.verifiedClaims) || brief.verifiedClaims.length === 0) {
    return { blocked: true, reasonCode: "BRIEF_NO_VERIFIED_CLAIMS" };
  }
  return { blocked: false };
}

function selectClaims(brief) {
  const eligible = brief.verifiedClaims.filter(
    (claim) =>
      claim &&
      typeof claim.claimId === "string" &&
      /^[a-f0-9]{64}$/.test(claim.claimId) &&
      typeof claim.claim === "string" &&
      claim.claim.trim().length > 0 &&
      claim.status === "corroborated" &&
      Array.isArray(claim.supportingDomains) &&
      claim.supportingDomains.length >= 2
  );
  return eligible.slice(0, MAX_SUPPORTING_CLAIMS);
}

function secondsForFormat(targetSeconds, format) {
  if (format === "explainer_short") return Math.min(60, targetSeconds);
  if (format === "news_recap") return targetSeconds;
  return Math.max(90, Math.min(180, targetSeconds));
}

function buildSections({ publicBrand, language, tone, targetSeconds, claims }) {
  const bodyCount = claims.length;
  const hookSeconds = Math.max(5, Math.round(targetSeconds * 0.12));
  const ctaSeconds = Math.max(4, Math.round(targetSeconds * 0.08));
  const caveatSeconds = Math.max(3, Math.round(targetSeconds * 0.05));
  const remaining = Math.max(0, targetSeconds - hookSeconds - ctaSeconds - caveatSeconds);
  const bodySeconds = bodyCount > 0 ? Math.floor(remaining / bodyCount) : 0;

  const bodySections = claims.map((claim, index) => ({
    order: index + 1,
    role: "body_claim",
    claimId: claim.claimId,
    claimTextEcho: claim.claim,
    supportingDomains: [...claim.supportingDomains].sort(),
    targetSeconds: bodySeconds,
    guidance:
      language === "hindi"
        ? `Present this corroborated claim factually, cite both independent publisher domains verbally, keep tone ${tone}, and do not add unverified numbers.`
        : language === "hinglish"
          ? `Is claim ko factually present karo, dono independent publisher domains mention karo, tone ${tone} rakho, aur koi unverified number add mat karo.`
          : `Present this corroborated claim factually, cite both independent publisher domains verbally, keep tone ${tone}, and do not add unverified numbers.`
  }));

  const hookSection = {
    order: 0,
    role: "hook",
    claimIds: bodySections.map((section) => section.claimId),
    targetSeconds: hookSeconds,
    guidance:
      language === "hindi"
        ? `Open with why this matters today for the ${publicBrand} audience without stating any number not present in the verified claims.`
        : language === "hinglish"
          ? `${publicBrand} audience ke liye aaj yeh kyu matter karta hai, yeh bina naye number bataye open karo.`
          : `Open with why this matters today for the ${publicBrand} audience without stating any number not present in the verified claims.`
  };

  const caveatSection = {
    order: bodyCount + 1,
    role: "caveat",
    targetSeconds: caveatSeconds,
    guidance:
      "State that claims are corroborated across the cited independent publisher domains and that any numeric divergence would block publication."
  };

  const ctaSection = {
    order: bodyCount + 2,
    role: "call_to_action",
    targetSeconds: ctaSeconds,
    guidance: "Invite the audience to follow the channel for verified updates. No engagement-bait, no unverified promises."
  };

  return { hookSection, bodySections, caveatSection, ctaSection };
}

export function createDeterministicEditorialPlan(input) {
  const { publicBrand, language, tone, format, targetSeconds, brief } = validateInput(input);

  const gate = validateReadyBrief(brief);
  if (gate.blocked) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      planType: PLAN_TYPE,
      generationMode: "deterministic_local",
      readiness: "blocked",
      reasonCode: gate.reasonCode,
      briefId: brief.briefId,
      ownerId: brief.scope?.ownerId ?? null,
      agentId: AGENT_ID,
      publicBrand,
      language,
      tone,
      format,
      targetSeconds,
      sections: [],
      selectedClaims: [],
      generatedNarrative: null,
      provenance: {
        providerCalls: 0,
        networkFetches: 0,
        inventedFacts: 0,
        inventedNumbers: 0,
        note: "Blocked honestly: the supplied brief did not satisfy corroboration or contradiction gates. No plan was produced and no text was generated."
      },
      publication: { requested: false, status: "not_requested" }
    });
  }

  const claims = selectClaims(brief);
  if (claims.length === 0) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      planType: PLAN_TYPE,
      generationMode: "deterministic_local",
      readiness: "blocked",
      reasonCode: "NO_ELIGIBLE_CLAIMS",
      briefId: brief.briefId,
      ownerId: brief.scope?.ownerId ?? null,
      agentId: AGENT_ID,
      publicBrand,
      language,
      tone,
      format,
      targetSeconds,
      sections: [],
      selectedClaims: [],
      generatedNarrative: null,
      provenance: {
        providerCalls: 0,
        networkFetches: 0,
        inventedFacts: 0,
        inventedNumbers: 0,
        note: "Blocked honestly: no corroborated claim in the brief passed eligibility checks. Nothing was generated."
      },
      publication: { requested: false, status: "not_requested" }
    });
  }

  const planSeconds = secondsForFormat(targetSeconds, format);
  const { hookSection, bodySections, caveatSection, ctaSection } = buildSections({
    publicBrand,
    language,
    tone,
    targetSeconds: planSeconds,
    claims
  });

  const sections = [hookSection, ...bodySections, caveatSection, ctaSection];

  const planIdentity = {
    schemaVersion: SCHEMA_VERSION,
    planType: PLAN_TYPE,
    briefId: brief.briefId,
    publicBrand,
    language,
    tone,
    format,
    planSeconds,
    claims: claims.map((claim) => claim.claimId)
  };
  const planId = sha256Hex(JSON.stringify(planIdentity));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    planId,
    planType: PLAN_TYPE,
    generationMode: "deterministic_local",
    readiness: "editorial_plan_only",
    briefId: brief.briefId,
    ownerId: brief.scope?.ownerId ?? null,
    agentId: AGENT_ID,
    publicBrand,
    language,
    tone,
    format,
    targetSeconds: planSeconds,
    sections: Object.freeze(sections),
    selectedClaims: Object.freeze(
      claims.map((claim) => ({
        claimId: claim.claimId,
        claimTextEcho: claim.claim,
        supportingDomains: [...claim.supportingDomains].sort(),
        supportingSourceIds: [...claim.supportingSourceIds].sort()
      }))
    ),
    unverifiedClaimsExcluded: brief.unresolvedClaims.length,
    generatedNarrative: null,
    generatedMedia: [],
    providerCalls: [],
    artifacts: [],
    provenance: {
      providerCalls: 0,
      networkFetches: 0,
      inventedFacts: 0,
      inventedNumbers: 0,
      note: "Structural editorial plan only. Sections reference verified claims; narration text is NOT generated and requires an approved free provider or owner-supplied input."
    },
    publication: { requested: false, status: "not_requested" }
  });
}
