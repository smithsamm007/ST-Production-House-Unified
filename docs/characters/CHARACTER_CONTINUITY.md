# Director-scoped character continuity contract (S-M31-01)

> Status: implemented (deterministic, offline, purely additive). This module
> stores and versions character STATE ONLY. No media generation, provider
> call, render, upload, or publishing is performed or claimed.

## Purpose

`src/characters/characterContinuity.js` gives each Director a durable,
Director-scoped character-continuity contract: identity, appearance,
personality, relationships, wardrobe, environment, timeline position,
locator-free voice-profile reference, and canonical prior events — versioned
and append-oriented.

This is the offline foundation for §8 (Character and Continuity) of the
master specification: a JARVIS character can never appear in another
Director's universe, and character history is never silently rewritten.

## Guarantees

| Guarantee | Mechanism |
|---|---|
| Director scoping | `agentId` must be a registered catalog id; cross-Director linking fails closed with `CHARACTER_ISOLATION_VIOLATION` |
| Deterministic identity | `id` = SHA-256 of canonical content, recomputed (`computeCharacterId`), never trusted from input |
| Identical inputs → byte-identical records | No clocks, no randomness; JSON-stable field order |
| Tamper detection | `verifyCharacterIntegrity` recomputes the id; `detectCharacterTampering` lists changed fields deterministically (id only via the integrity gate) |
| Append-only history | `reviseCharacter` / `appendCanonicalEvent` always emit a NEW record with `previousVersionId` linking to the predecessor; identity/scope fields are immutable (`CHARACTER_FIELD_IMMUTABLE`) |
| Version bounds | integer 1..100000; `previousVersionId` must be a 64-hex record id |
| Rules 15/17 | free text and keys reject secret-like material (`CHARACTER_SECRET_REJECTED`) and internal agent names (`CHARACTER_INTERNAL_NAME_REJECTED`); serialization is a strict allowlist — polluted fields can never leak |
| Fail-closed | malformed input throws stable codes; nothing is coerced or repaired |

## Field bounds

- `characterKey` / relationship targets / event keys: `/^[a-z0-9][a-z0-9._-]{2,60}$/`
- `displayName` ≤ 80 chars; appearance/personality ≤ 600; wardrobe/environment ≤ 300; timeline ≤ 120
- relationships ≤ 12 (unique targets); canonicalEvents ≤ 50 (unique keys)
- `voiceProfileRef`: `{ profileId, note? }` — locator-free by construction (S-M32-01 profiles carry no credentials)

## Error codes

`CHARACTER_RECORD_INVALID`, `CHARACTER_AGENT_INVALID`,
`CHARACTER_KEY_INVALID`, `CHARACTER_DISPLAY_NAME_INVALID`,
`CHARACTER_APPEARANCE_INVALID`, `CHARACTER_PERSONALITY_INVALID`,
`CHARACTER_WARDROBE_INVALID`, `CHARACTER_ENVIRONMENT_INVALID`,
`CHARACTER_TIMELINE_INVALID`, `CHARACTER_VOICE_REF_INVALID`,
`CHARACTER_RELATIONSHIP_INVALID` / `_LIMIT` / `_DUPLICATE`,
`CHARACTER_EVENT_INVALID` / `_LIMIT` / `_DUPLICATE`,
`CHARACTER_VERSION_INVALID` / `_LIMIT`, `CHARACTER_PREVIOUS_VERSION_INVALID`,
`CHARACTER_FIELD_IMMUTABLE`, `CHARACTER_ID_MISMATCH`,
`CHARACTER_RECORD_TYPE_MISMATCH`, `CHARACTER_SECRET_REJECTED`,
`CHARACTER_INTERNAL_NAME_REJECTED`, `CHARACTER_ISOLATION_VIOLATION`,
`CHARACTER_REVISION_INVALID`.

## Non-goals

- No persistence layer (a later DB slice will mirror these invariants as
  constraints); no cross-universe sharing contract (explicit future feature);
  no public-facing identity — Rule 15 applies to every free-text field.
