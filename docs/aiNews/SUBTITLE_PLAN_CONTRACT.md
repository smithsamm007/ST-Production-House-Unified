# AI News Narration Registry & Deterministic Subtitle Plan (Stage 4)

> Status: implemented (deterministic, offline). This slice produces CUE TIMING
> PLANS ONLY. No provider call, narration synthesis, media generation, upload,
> publishing, or deployment is performed or claimed by this document.

## Purpose

`src/aiNews/deterministicSubtitlePlan.js` contains two pure, offline
components that complete the AI News chain through the subtitle stage:

1. **Narration input registry** (`createNarrationInputRegistry`) — validates
   owner/agent-supplied timed narration segments (monotonic, non-overlapping,
   bounded) into an immutable, tamper-evident registry with a SHA-256
   `registryId`. The registry never invents narration: it only normalizes and
   hashes text the caller supplied.
2. **Subtitle plan builder** (`createDeterministicSubtitlePlan`) — converts
   ONE verified research brief, its approved editorial plan (integrity-checked
   by recomputing its `planId`), and a registered narration input into a
   deterministic subtitle plan.

This is the fourth stage of the AI News pipeline (Module 27/21), continuing
the proven pattern: research brief → editorial plan → metadata/thumbnail plan
→ **subtitle plan** → (next slice: package orchestrator chaining all stages).

## Narration registry contract

| Field | Value |
|---|---|
| Registry type | `ai_news_narration_registry` |
| Schema | `schemaVersion: 1` |
| Agent scope | `agent-ai-news` (fixed; other agents fail closed) |
| Owner scope | `/^[a-zA-Z0-9_-]{3,80}$/`, must match the brief scope at plan time |
| Language | `hindi`/`hinglish`/`english`, must match the editorial plan language |
| Output | Frozen registry: normalized segments + `registryId` + totals |

### Segment validation (fail closed, stable codes)

- `SUBTITLE_SEGMENTS_INVALID` / `SUBTITLE_SEGMENTS_EXCESSIVE` — missing/empty
  or more than 500 segments.
- `SUBTITLE_SEGMENT_ID_INVALID` / `SUBTITLE_SEGMENT_DUPLICATE_ID` — missing,
  oversized (>120 chars), or duplicate `segmentId`.
- `SUBTITLE_TEXT_INVALID` — missing or blank narration text (>2000 chars).
- `SUBTITLE_TIMING_INVALID` — non-finite, negative, or `end <= start` times.
- `SUBTITLE_TIMING_OVERLAP_DETECTED` — a segment starting before the previous
  segment ends (strictly monotonic timeline).
- `SUBTITLE_SEGMENT_DURATION_EXCESSIVE` — a segment longer than 60 seconds.
- `SUBTITLE_TOTAL_DURATION_EXCESSIVE` — a total timeline longer than 900
  seconds (15 minutes).
- `SUBTITLE_SECRET_REJECTED` — secret-like input (Rule 17).
- `SUBTITLE_INTERNAL_NAME_REJECTED` — internal agent names in public text
  (Rule 15).
- `SUBTITLE_MARKUP_UNSUPPORTED` — HTML/JS markup in public text.

The registry is deterministic: identical inputs produce an identical
`registryId`; different owners, languages, or segment contents produce
different ids.

## Subtitle plan contract

| Field | Value |
|---|---|
| Plan type | `ai_news_subtitle_plan` |
| Schema | `schemaVersion: 1` |
| Inputs | Verified `ai_news_research_brief` + approved `ai_news_editorial_plan` (ids recomputed; tampering fails closed) + registered narration |
| Output | Frozen plan: 16:9 long-form cue timeline + 9:16 shorts adaptation, SRT/VTT timestamps |
| Determinism | Identical inputs always produce the identical SHA-256 `planId` |
| Integrity | Editorial plan id and narration registry id are both RECOMPUTED from contents; any mismatch fails closed |

### Binding checks (fail closed)

- `SUBTITLE_BRIEF_CONTRACT_MISMATCH`, `SUBTITLE_BRIEF_NOT_LOCAL`,
  `SUBTITLE_BRIEF_AGENT_MISMATCH` — the brief must be a local, verified AI
  News brief scoped to `agent-ai-news`.
- `SUBTITLE_EDITORIAL_PLAN_INVALID`, `SUBTITLE_EDITORIAL_PLAN_CONTRACT_MISMATCH`,
  `SUBTITLE_EDITORIAL_PLAN_NOT_LOCAL`, `SUBTITLE_EDITORIAL_PLAN_ID_MISMATCH`,
  `SUBTITLE_EDITORIAL_PLAN_PUBLICATION_STATE_INVALID` — the editorial plan
  must be local, non-publication, and tamper-free.
- `SUBTITLE_BRIEF_PLAN_MISMATCH` — the plan must be built from the same
  brief it is paired with.
- `SUBTITLE_REGISTRY_INVALID`, `SUBTITLE_REGISTRY_ID_MISMATCH`,
  `SUBTITLE_REGISTRY_AGENT_MISMATCH`, `SUBTITLE_REGISTRY_LANGUAGE_MISMATCH`,
  `SUBTITLE_REGISTRY_OWNER_MISMATCH` — the registry must be structurally
  valid, tamper-free, and bound to the same agent, language, and owner scope.

### Cue derivation (echo-only)

- Cue text is the supplied narration split at safe whitespace word
  boundaries: ≤42 characters per cue and ≤7.0 seconds per cue. Full words are
  preserved; Devanagari Hindi / Hinglish / English text is never mutated.
- Segment duration is distributed across cues proportionally by word count.
  Timings are monotonic and millisecond-precision (`roundMs`).
- Cues carry `srtFormatted` / `vttFormatted` strings with standard `HH:MM:SS,mmm`
  (SRT) and `HH:MM:SS.mmm` (VTT) timestamps.
- **No text is ever generated.** `provenance.inventedNarrationSegments` stays 0.

### Profiles

- **Long-form (16:9):** 1920x1080, full sequential cue timeline with
  `sequence` numbering and formatted SRT/VTT strings.
- **Shorts adaptation (9:16):** 1080x1920, the SAME verified cue timeline
  framed for vertical distribution (`sourceProfile: "long_form_echo"`). This
  is format adaptation only — no re-curation, no new text, no new timing.

## Truthfulness boundaries

1. **No narration is generated.** Cue text echoes supplied segments only.
2. **No invented facts or numbers.** `provenance.inventedFacts` and
   `inventedNumbers` stay 0.
3. **No provider or network calls.** `providerCalls` stays empty;
   `provenance.providerCalls` and `networkFetches` stay 0.
4. **No publication.** `publication.status` stays `not_requested`.
5. **Honest blocking.** A blocked editorial plan yields a truthful blocked
   result carrying the upstream `reasonCode` (e.g.
   `BRIEF_INSUFFICIENT_CORROBORATION`) — never cues built on unverified
   claims.
6. **No scope drift.** Brief, plan, and registry must agree on owner, agent,
   and language; any mismatch fails closed.

## Verification

`tests/aiNewsSubtitlePlan.test.js` covers: registry determinism and freezing,
id divergence across inputs, all stable failure codes, Rule 15/17 rejections,
plan determinism, echo-only cue reconstruction, timing/format bounds, truthful
provenance counters, honest blocked propagation, brief/plan/registry binding
failures, and registry tamper detection.

Evidence from this slice: `npm test` 478/478 passing (13 new in
`tests/aiNewsSubtitlePlan.test.js`), `npm run verify`, `npm run lint`, and
`npm run plan:check` all pass on the slice branch.
