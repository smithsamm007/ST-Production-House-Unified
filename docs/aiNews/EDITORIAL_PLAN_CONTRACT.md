# AI News Deterministic Editorial Plan

> Status: implemented (deterministic, offline). This slice produces PLANS ONLY.
> No provider call, narration synthesis, media generation, upload, publishing, or
> deployment is performed or claimed by this document.

## Purpose

`src/aiNews/deterministicEditorialPlan.js` converts ONE verified,
provenance-first research brief (from `src/aiNews/deterministicResearchBrief.js`)
into a bounded editorial PLAN for a short news explainer. The plan is structural
only: it selects which corroborated claims are presented in which order and
drafts per-section guidance. It never writes narration text.

This is the second stage of the AI News pipeline (Module 27), generalizing the
JARVIS content-package pattern: research brief → **editorial plan** → (future:
narration via approved free providers or owner-supplied input → subtitle plan →
metadata plan).

## Stage contract

| Field | Value |
|---|---|
| Plan type | `ai_news_editorial_plan` |
| Schema | `schemaVersion: 1` |
| Agent scope | `agent-ai-news` (fixed; brief scope must match exactly) |
| Inputs | A verified `ai_news_research_brief`, public brand, language (`hindi`/`hinglish`/`english`), tone (`factual`/`explainer`/`urgent`/`measured`), format (`explainer_short`/`explainer_standard`/`news_recap`), `targetSeconds` (45–600) |
| Output | Frozen plan with `hook → body_claim* → caveat → call_to_action` sections, per-section timing, and claim provenance echoes |
| Determinism | Identical inputs always produce the identical SHA-256 `planId` |

## Corroboration gates (fail closed)

The planner blocks honestly (returns `readiness: "blocked"` with a reason code,
empty sections, no generated content) when:

1. `BRIEF_INSUFFICIENT_CORROBORATION` — the brief itself was not ready for
   editorial review (fewer than two independent publisher domains).
2. `BRIEF_CONTRADICTIONS_UNRESOLVED` — the brief carries numeric-divergence
   contradiction flags. Divergence is surfaced to the owner, never silently
   resolved or averaged.
3. `BRIEF_NO_VERIFIED_CLAIMS` — the brief contains no corroborated claims.
4. `NO_ELIGIBLE_CLAIMS` — no claim passed structural eligibility checks
   (valid `claimId`, corroborated status, ≥2 supporting domains).

A blocked result is a truthful, resumable state — not an error. Nothing is
generated from unverified claims.

## Truthfulness boundaries

1. **No narrative is generated.** `generatedNarrative` stays `null`. Sections
   contain `guidance` strings (how to present a claim) and verbatim echoes of
   verified claim text — never new sentences.
2. **No invented numbers.** Claim text is echoed exactly; `provenance
   .inventedNumbers` stays 0. Numeric divergence blocks planning.
3. **No provider or network calls.** `providerCalls` stays empty;
   `provenance.providerCalls` and `networkFetches` stay 0.
4. **No publication.** `publication.status` stays `not_requested`.
5. **No scope drift.** The plan inherits the brief's owner scope and pins the
   `agent-ai-news` agent; any mismatch fails closed.
6. **Rule 15**: internal agent names are rejected in public text fields.
7. **Rule 17**: secret-like inputs are rejected (`EDITORIAL_PLAN_SECRET_REJECTED`).

## Verification

`tests/aiNewsEditorialPlan.test.js` (13 tests) covers: determinism and plan-id
identity, section ordering and claim-provenance echoes, zero-generation
provenance counters, deterministic claim ordering, seconds-budget integrity,
distinct briefs producing distinct plan ids, all four blocking gates, and
fail-closed rejection of malformed input, secrets, internal agent names, URLs,
scope mismatch, and non-deterministic briefs.

Evidence from the merged PR: `npm test` 444/444 passing, `npm run verify`,
`npm run lint`, and `npm run plan:check` all pass.
