# Rights-aware BGM/SFX audio-asset registry contract (S-M36-01)

> Status: implemented (deterministic, offline, purely additive). This module
> records DECLARATIONS AND SELECTIONS ONLY. No audio generation, provider
> call, render, upload, or publishing is performed or claimed. No media
> payload can be expressed through this contract.

## Purpose

`src/media/audioAssetRegistry.js` is the rights-gating contract between the
free/licensed audio supply side and the assembly audio-mix plans (S-M33-01,
roles `voice | bgm | sfx`):

- **Declarations** (`declareAudioAsset`): one Director-scoped asset with
  `assetKey`, `kind` (`bgm | ambient | sfx | transition_sting`),
  `sourceProviderId`, bounded `sourceDescription`, an explicit `licenseState`,
  optional bounded `licenseNote`, and ≤ 10 descriptive tags.
- **Structural prohibition of bundled media**: the accepted field set cannot
  express a payload, file path, or URL — unknown fields fail closed
  (`AUDIO_ASSET_FIELD_UNKNOWN`) and no allowlisted field accepts file-like
  data. Bundled third-party media cannot be smuggled through this contract
  (AGENTS.md Rule 12).
- **Selections** (`selectAudioAsset`): bind an asset into one audio-mix role
  for one Director run, optionally binding the rendered audio artifact's
  descriptor identity (`sha256:<64-hex>`).

## Rights gating (fail-closed)

`AUDIO_LICENSE_STATES` is a bounded enum:

- Selectable (documented rights): `license_documented_commercial`,
  `license_documented_cc0`, `license_documented_cc_by_attribution`,
  `license_documented_public_domain`, `license_documented_owner_owned`.
- NEVER selectable: `undocumented`, `unknown`, `prohibited` — selection throws
  `AUDIO_LICENSE_NOT_DOCUMENTED`.

A declaration is a governance-recorded assertion of rights, not a legal
determination; the owner remains the authority on licensing (owner-gated
policy).

## Director scoping

Selections bind one registered Director (`agentId` must own the asset);
cross-Director use fails with `AUDIO_SCOPE_MISMATCH`. Rule 15 applies: internal
agent names are rejected in all free text; Rule 17: secrets are rejected and
serialization is a strict allowlist.

## Determinism and integrity

Assets and selections are frozen, byte-identical for identical inputs, with
recomputed SHA-256 ids (`computeAudioAssetId`, `computeAudioSelectionId`),
truthful verdicts (`verifyAudioAsset`, `verifyAudioSelection` — never repair),
and `detectAudioTampering` fingerprints. `serializeAudioRecord` projects onto
the strict allowlist in fixed order; polluted keys are dropped and can never
leak; tampered records fail serialization.

## Error codes

`AUDIO_ASSET_INVALID` / `_FIELD_UNKNOWN` / `_KEY_INVALID` / `_KIND_INVALID` /
`_MALFORMED` / `_TAMPERED`, `AUDIO_LICENSE_STATE_INVALID`,
`AUDIO_LICENSE_NOT_DOCUMENTED`, `AUDIO_LICENSE_NOTE_INVALID`,
`AUDIO_SOURCE_INVALID`, `AUDIO_TAG_INVALID`, `AUDIO_PROVIDER_INVALID`,
`AUDIO_AGENT_INVALID`, `AUDIO_SCOPE_MISMATCH`, `AUDIO_SELECTION_INVALID` /
`_MALFORMED` / `_TAMPERED`, `AUDIO_ROLE_INVALID`, `AUDIO_RUN_INVALID`,
`AUDIO_ARTIFACT_REF_INVALID`, `AUDIO_SECRET_REJECTED`,
`AUDIO_INTERNAL_NAME_REJECTED`.

## Non-goals

No audio generation, no storage, no license verification service (a future
owner-facing slice may verify declarations against real license documents),
no publication. The selection records are the input contract for assembly
audio mixes.
