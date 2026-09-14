# AI News Deterministic Metadata & Thumbnail Plan

> Status: implemented (deterministic, offline). This stage produces DRAFTS and a
> BRIEF only. No provider call, image generation, upload, publishing, or
> deployment is performed or claimed by this document.

## Purpose

`src/aiNews/deterministicMetadataPlan.js` is stage 3 of the AI News pipeline.
It converts ONE verified research brief plus its deterministic editorial plan
into:

- Title variants (echoes of a corroboration-eligible source headline and/or
  verified claim text, bounded to 100 chars).
- A description echoing the top verified claim, the REAL independent publisher
  domains and their count, and the newest observation timestamp.
- Hashtags from a fixed per-language set and overlay text from a small factual
  allowlist (the "2 independent sources confirm" phrasing reflects the real
  upstream corroboration gate — never an invented claim).
- A thumbnail BRIEF (composition/mood/colors) with `generatedAsset: null`.

Pipeline position: research brief → editorial plan → **metadata & thumbnail
plan** → (future: narration via approved free providers or owner input).

## Integrity model

1. The editorial plan's `planId` is RECOMPUTED from its own fields using the
   same identity construction as `deterministicEditorialPlan.js`. A mismatch
   (`METADATA_PLAN_EDITORIAL_PLAN_ID_MISMATCH`) means the plan was tampered
   with or forged; validation fails closed.
2. The plan and brief must share the same `briefId`
   (`METADATA_PLAN_BRIEF_PLAN_MISMATCH`), and both must be pinned to
   `agent-ai-news`.
3. Safety checks (secrets, internal agent names, URLs, publication state) run
   BEFORE integrity verification so a forged id cannot bypass them.
4. A blocked editorial plan yields a truthful blocked metadata result carrying
   the upstream reason code; drafts are never composed from unverified content.

## Truthfulness boundaries

- `generatedAsset` stays `null`; `generatedAssets` stays empty.
- `providerCalls` stays empty; `provenance.providerCalls`/`networkFetches` = 0.
- No invented facts or numbers: `inventedFacts`/`inventedNumbers` stay 0 and
  every number in the drafts is derived from the brief's real corroboration
  data.
- `publication.status` stays `not_requested`.
- Rule 15 / Rule 17 enforced on all public text fields.

## Verification

`tests/aiNewsMetadataPlan.test.js` (8 tests) covers: determinism and plan-id
identity, provenance echo (headline, domains, domain count), overlay-text
allowlist for all three languages, distinct briefs → distinct ids, blocked
upstream propagation, plan-id tamper rejection, brief/plan binding rejection,
secret/internal-name/agent-mismatch rejection, and publication-state tamper
rejection.
