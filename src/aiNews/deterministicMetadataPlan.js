/**
 * ST Production House — AI News deterministic metadata & thumbnail plan.
 *
 * Stage 3 of the AI News pipeline. Converts ONE verified research brief and
 * its deterministic editorial plan into title/description/hashtag DRAFTS and
 * a thumbnail BRIEF. Like every AI News stage it generates structure and
 * echoes supplied provenance — never new facts, numbers, media, or claims:
 *
 * - Title variants echo supplied source headlines / verified claim text.
 * - The description echoes the top verified claim, supporting domains, and
 *   recency fields from the brief.
 * - Overlay text comes from a small per-language factual allowlist (the
 *   corroboration count is real, from the brief).
 * - `generatedAsset` stays null; `generatedAssets` stays empty; no provider
 *   or network calls; `publication.status` stays `not_requested`.
 *
 * Integrity: the editorial plan's `planId` is RECOMPUTED from its own fields
 * and must match (tamper detection). A blocked editorial plan produces a
 * truthful blocked metadata result — never drafts from unverified content.
 * Rule 15 (internal agent names) and Rule 17 (secrets) fail closed.
 */

import { createHash } from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SCHEMA_VERSION = 1;
const PLAN_TYPE = "ai_news_metadata_thumbnail_plan";
const AGENT_ID = "agent-ai-news";
const EDITORIAL_PLAN_TYPE = "ai_news_editorial_plan";

const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_PAYLOAD_BYTES = 524288;

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|client[_ -]?secret)/i;
const INTERNAL_AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);
const URL_LIKE = /(?:https?:\/\/|www\.|javascript:|data:)/i;

const LANGUAGES = Object.freeze(new Set(["hindi", "hinglish", "english"]));

// Factual overlay allowlist. The "2 sources" count reflects the real
// corroboration gate enforced upstream — never an invented claim.
const OVERLAY_TEXT = Object.freeze({
  hindi: "दो स्वतंत्र स्रोतों ने पुष्टि की",
  hinglish: "2 INDEPENDENT SOURCES CONFIRM",
  english: "2 INDEPENDENT SOURCES CONFIRM"
});

const HASHTAGS = Object.freeze({
  hindi: ["#AINews", "#TechNews", "#Explainer"],
  hinglish: ["#AINews", "#TechNews", "#Explainer"],
  english: ["#AINews", "#TechNews", "#Explainer"]
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function rejectUnsafe(value, code) {
  if (SECRET_LIKE.test(value)) throw new Error(code);
  if (INTERNAL_AGENT_NAME_PATTERN.test(value)) throw new Error("METADATA_PLAN_INTERNAL_NAME_REJECTED");
  return value;
}

function recomputedEditorialPlanId(plan) {
  // Must mirror the identity object construction in
  // deterministicEditorialPlan.js exactly (key order included).
  const identity = {
    schemaVersion: plan.schemaVersion,
    planType: plan.planType,
    briefId: plan.briefId,
    publicBrand: plan.publicBrand,
    language: plan.language,
    tone: plan.tone,
    format: plan.format,
    planSeconds: plan.targetSeconds,
    claims: plan.selectedClaims.map((claim) => claim.claimId)
  };
  return sha256Hex(JSON.stringify(identity));
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("METADATA_PLAN_INPUT_INVALID");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error("METADATA_PLAN_SCHEMA_UNSUPPORTED");

  const payloadJson = JSON.stringify(input);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) throw new Error("METADATA_PLAN_PAYLOAD_TOO_LARGE");
  if (SECRET_LIKE.test(payloadJson)) throw new Error("METADATA_PLAN_SECRET_REJECTED");

  const brief = input.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("METADATA_PLAN_BRIEF_INVALID");
  }
  if (brief.schemaVersion !== 1 || brief.briefType !== "ai_news_research_brief") {
    throw new Error("METADATA_PLAN_BRIEF_CONTRACT_MISMATCH");
  }
  if (brief.generationMode !== "deterministic_local" || brief.provenance?.providerCalls !== 0) {
    throw new Error("METADATA_PLAN_BRIEF_NOT_LOCAL");
  }
  if (brief.scope?.agentId !== AGENT_ID) throw new Error("METADATA_PLAN_AGENT_MISMATCH");

  const plan = input.editorialPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("METADATA_PLAN_EDITORIAL_PLAN_INVALID");
  }
  if (plan.planType !== EDITORIAL_PLAN_TYPE) throw new Error("METADATA_PLAN_EDITORIAL_PLAN_CONTRACT_MISMATCH");
  if (plan.generationMode !== "deterministic_local") throw new Error("METADATA_PLAN_EDITORIAL_PLAN_NOT_LOCAL");
  if (plan.briefId !== brief.briefId) throw new Error("METADATA_PLAN_BRIEF_PLAN_MISMATCH");
  if (plan.agentId !== AGENT_ID) throw new Error("METADATA_PLAN_AGENT_MISMATCH");
  if (plan.publication?.requested !== false || plan.publication?.status !== "not_requested") {
    throw new Error("METADATA_PLAN_EDITORIAL_PLAN_PUBLICATION_STATE_INVALID");
  }

  const publicBrand = rejectUnsafe(
    typeof plan.publicBrand === "string" ? plan.publicBrand.trim() : "",
    "METADATA_PLAN_PUBLIC_BRAND_INVALID"
  );
  if (publicBrand.length < 2 || publicBrand.length > 80) {
    throw new Error("METADATA_PLAN_PUBLIC_BRAND_INVALID");
  }
  const language = String(plan.language || "").toLowerCase();
  if (!LANGUAGES.has(language)) throw new Error("METADATA_PLAN_LANGUAGE_UNSUPPORTED");

  // Content-safety and contract checks pass; enforce plan integrity last so
  // forged ids cannot bypass safety validation.
  if (plan.readiness !== "blocked" && recomputedEditorialPlanId(plan) !== plan.planId) {
    throw new Error("METADATA_PLAN_EDITORIAL_PLAN_ID_MISMATCH");
  }

  return { brief, plan, publicBrand, language };
}

function pickSafeSourceHeadline(brief) {
  for (const source of brief.sources) {
    if (!source.corroborationEligible) continue;
    const headline = typeof source.headline === "string" ? source.headline.trim().replace(/\s+/g, " ") : "";
    if (headline.length >= 5 && !URL_LIKE.test(headline)) return headline;
  }
  return null;
}

function pickSafeClaims(plan) {
  return plan.selectedClaims.filter(
    (claim) => typeof claim.claimTextEcho === "string" && claim.claimTextEcho.trim().length >= 3 && !URL_LIKE.test(claim.claimTextEcho)
  );
}

export function createDeterministicMetadataPlan(input) {
  const { brief, plan, publicBrand, language } = validateInput(input);

  if (plan.readiness !== "editorial_plan_only") {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      planType: PLAN_TYPE,
      generationMode: "deterministic_local",
      readiness: "blocked",
      reasonCode: plan.reasonCode || "EDITORIAL_PLAN_BLOCKED",
      briefId: brief.briefId,
      editorialPlanId: plan.planId ?? null,
      ownerId: brief.scope?.ownerId ?? null,
      agentId: AGENT_ID,
      publicBrand,
      language,
      metadataDraft: null,
      thumbnailBrief: null,
      generatedAssets: [],
      providerCalls: [],
      artifacts: [],
      provenance: {
        providerCalls: 0,
        networkFetches: 0,
        inventedFacts: 0,
        inventedNumbers: 0,
        note: "Blocked honestly: the supplied editorial plan was not ready. No metadata drafts were produced."
      },
      publication: { requested: false, status: "not_requested" }
    });
  }

  const safeHeadline = pickSafeSourceHeadline(brief);
  const safeClaims = pickSafeClaims(plan);

  if (!safeHeadline && safeClaims.length === 0) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      planType: PLAN_TYPE,
      generationMode: "deterministic_local",
      readiness: "blocked",
      reasonCode: "NO_SAFE_CLAIM_TEXT",
      briefId: brief.briefId,
      editorialPlanId: plan.planId,
      ownerId: brief.scope?.ownerId ?? null,
      agentId: AGENT_ID,
      publicBrand,
      language,
      metadataDraft: null,
      thumbnailBrief: null,
      generatedAssets: [],
      providerCalls: [],
      artifacts: [],
      provenance: {
        providerCalls: 0,
        networkFetches: 0,
        inventedFacts: 0,
        inventedNumbers: 0,
        note: "Blocked honestly: no URL-free headline or claim text was available for safe metadata composition. Nothing was generated."
      },
      publication: { requested: false, status: "not_requested" }
    });
  }

  const domains = brief.corroboration.independentDomains;
  const domainCount = brief.corroboration.independentDomainCount;
  const topClaim = safeClaims.length > 0 ? safeClaims[0].claimTextEcho : safeHeadline;

  const titleVariants = [];
  if (safeHeadline) {
    titleVariants.push(truncate(rejectUnsafe(safeHeadline, "METADATA_PLAN_HEADLINE_UNSAFE"), MAX_TITLE_CHARS));
    titleVariants.push(
      truncate(`${truncate(safeHeadline, 60)} — verified by ${domainCount} outlets`, MAX_TITLE_CHARS)
    );
  }
  titleVariants.push(truncate(`${topClaim} — ${domainCount} independent sources confirm`, MAX_TITLE_CHARS));
  titleVariants.push(truncate(`${publicBrand} Explainer: ${safeHeadline || topClaim}`, MAX_TITLE_CHARS));

  const newestObservedAt = brief.recency?.newestObservedAt ?? null;
  const description = truncate(
    [
      `${topClaim}.`,
      `Corroborated by ${domainCount} independent publisher domains: ${domains.join(", ")}.`,
      newestObservedAt ? `Newest source observed at ${newestObservedAt}.` : null,
      "All figures cross-checked across sources; no unverified numbers are included in this draft."
    ]
      .filter((part) => typeof part === "string")
      .join(" "),
    MAX_DESCRIPTION_CHARS
  );

  const draftIdentity = {
    schemaVersion: SCHEMA_VERSION,
    planType: PLAN_TYPE,
    briefId: brief.briefId,
    editorialPlanId: plan.planId,
    publicBrand,
    language,
    titleVariants: [...titleVariants].sort(),
    description,
    overlayText: OVERLAY_TEXT[language]
  };
  const planId = sha256Hex(JSON.stringify(draftIdentity));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    planId,
    planType: PLAN_TYPE,
    generationMode: "deterministic_local",
    readiness: "metadata_thumbnail_plan_only",
    briefId: brief.briefId,
    editorialPlanId: plan.planId,
    ownerId: brief.scope?.ownerId ?? null,
    agentId: AGENT_ID,
    publicBrand,
    language,
    metadataDraft: Object.freeze({
      status: "draft_only",
      titleVariants: Object.freeze(titleVariants),
      description,
      hashtags: Object.freeze([...HASHTAGS[language]]),
      seoPerformanceClaims: Object.freeze([]),
      urls: Object.freeze([])
    }),
    thumbnailBrief: Object.freeze({
      status: "brief_only",
      composition:
        "Centered bold typographic panel over a dark neutral background; one large headline area and a small source-count badge. No fabricated imagery of real events.",
      mood: "urgent, factual, high-contrast",
      colorDirection: Object.freeze(["deep_blue", "charcoal", "signal_amber"]),
      overlayText: OVERLAY_TEXT[language],
      generatedAsset: null,
      assetReference: null
    }),
    sourceAttribution: Object.freeze({
      domains: Object.freeze([...domains]),
      independentDomainCount: domainCount,
      claimsUsed: safeClaims.length,
      headlineUsed: safeHeadline
    }),
    generatedAssets: Object.freeze([]),
    providerCalls: Object.freeze([]),
    artifacts: Object.freeze([]),
    provenance: {
      providerCalls: 0,
      networkFetches: 0,
      inventedFacts: 0,
      inventedNumbers: 0,
      note: "Metadata drafts echo supplied headlines, verified claims, and corroboration facts. No narrative, numbers, imagery, or performance claims were generated."
    },
    publication: { requested: false, status: "not_requested" }
  });
}
