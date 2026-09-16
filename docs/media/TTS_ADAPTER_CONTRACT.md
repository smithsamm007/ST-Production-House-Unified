# TTS adapter contract + persistent voice continuity (S-M32-01)

> Status: implemented (contract layer only — deterministic, offline). This
> module performs NO audio generation, NO provider calls, NO filesystem
> access, and NO clock reads. It defines the truthful contract the future
> real TTS workers implement against.

## Purpose

`src/media/ttsAdapter.js` is the media-pipeline contract for text-to-speech:

1. **Provider routing is a fixed free-first chain** (`TTS_PROVIDER_TIERS`,
   contract order, never reordered):
   `approved_free_primary → approved_free_secondary → approved_free_tertiary
   → local_open_source_emergency`. There is no paid fallback, no account
   rotation, and no unapproved-provider path anywhere in the contract.
2. **Voice continuity profiles** (`createVoiceProfile`) bind one Director —
   and optionally one character — to one provider slot, model, voice,
   language, pronunciation profile, speaking rate, pitch, and emotion so
   narration stays consistent across production runs. Profiles never store
   credential material (Rule 17): credentials live in the credential broker
   behind opaque locators, which this contract has no field for.
3. **Generation outcomes are truthful by construction**
   (`recordTtsGenerationOutcome`): a provider call that claims `succeeded`
   is a *claim*, not evidence. The outcome's `mediaStatus` and
   `generationMode` derive exclusively from the artifact descriptor's
   verification state (S-M30-01): `provider_generated` only for a VERIFIED
   descriptor — reachable solely through the descriptor module's promotion
   path (a real matching inspection result) — and `not_evidenced` otherwise.
4. **Quota honesty**: `quota_exhausted` maps to the durable state
   `WAITING_FOR_QUOTA` (`resolveTtsQuotaState`) — never disguised as success.

## Contract surface

| Export | Purpose |
|---|---|
| `declareTtsProviderCapabilities` | Adapter capability *claim* (languages, voices, emotion/rate/pitch support + bounds); deterministic id; metadata for routing, never evidence of generation |
| `createVoiceProfile` / `verifyVoiceProfile` / `computeVoiceProfileId` | Frozen profile with recomputed SHA-256 id; tamper detection returns `{ok, reasonCode}` without throwing |
| `recordTtsGenerationOutcome` | The fail-closed outcome record (see below) |
| `verifyTtsOutcome` / `computeTtsOutcomeId` | Recomputed ids; `TTS_OUTCOME_TAMPERED` on any field drift |
| `ttsProviderChain` / `resolveTtsQuotaState` | Frozen chain view; status → truthful quota state |
| `serializeTtsOutcomeForDashboard` / `serializeVoiceProfileForDashboard` | Strict Rule-17 allowlist projections (frozen, unknown fields dropped, identity re-verified first) |

## Fail-closed behavior

| Situation | Stable error code |
|---|---|
| Unregistered/malformed agent id | `TTS_AGENT_INVALID` |
| Unknown provider role (e.g. any paid role) | `TTS_PROVIDER_ROLE_INVALID` |
| Provider id shape invalid (incl. locator-shaped strings) | `TTS_PROVIDER_INVALID` |
| Secret-like text in any field (Rule 17) | `TTS_SECRET_REJECTED` |
| Internal agent name in free text (Rule 15) | `TTS_INTERNAL_NAME_REJECTED` |
| Non-audio descriptor / forged verification block | `TTS_DESCRIPTOR_INVALID` |
| Profile agent ≠ descriptor producer agent | `TTS_AGENT_SCOPE_MISMATCH` |
| Profile provider ≠ call provider/role | `TTS_PROVIDER_MISMATCH` |
| Unknown call status | `TTS_PROVIDER_CALL_INVALID` |
| Tampered profile / outcome | `TTS_PROFILE_TAMPERED` / `TTS_OUTCOME_TAMPERED` |

The outcome re-validates a VERIFIED descriptor's verification block
explicitly (allowlisted inspection tool, no reason code, real timestamp) —
the descriptor fingerprint excludes the verification block by design, so a
hand-forged "verified" descriptor is rejected here.

## Determinism

Identical inputs produce byte-identical profiles/outcomes (recomputed
SHA-256 ids, fixed key order, no clocks). Different agents, characters,
voices, emotions, verification states, or call statuses produce different
ids.

## Verification

`tests/ttsAdapter.test.js` (23 tests) covers: the frozen free-first chain
(with paid roles rejected), capability declaration determinism and
malformed-input codes, profile binding/determinism/secret rejection/Rule 15,
profile fail-closed codes, profile tamper detection, unverified-by-default
outcomes, real-inspection promotion to `provider_generated`, quota honesty
(`WAITING_FOR_QUOTA`), hash-mismatch demotion, failed-call honesty,
Director scope enforcement, provider mismatch, forged-verification
rejection, non-audio rejection, outcome determinism and tamper matrix, and
allowlist serialization for outcomes and profiles.

Evidence from this slice: `npm test` 647/647 passing (23 new), `npm run
verify`, `npm run lint`, and `npm run plan:check` all pass on the slice
branch. No new dependencies; no bundled audio; no provider calls.
