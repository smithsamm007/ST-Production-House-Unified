# Deterministic per-agent package-profile manifest (S-M23-01)

> Status: implemented (deterministic, offline, purely additive). This module
> produces PLANNING METADATA ONLY. No provider call, media generation,
> rendering, upload, publishing, or deployment is performed or claimed.

## Purpose

`src/jarvis/packageProfileManifest.js` expresses, per package run, **what the
package must contain and where each output may go** — the platform-adaptation
manifest — without rewriting any existing planner contract (R5):

- **Canonical default profile** (`canonical_default_v1`): exactly
  **1 long-form episode** (runtime bounds 1800–3000 s = 30–50 minutes;
  destinations **YouTube + Bilibili only**), **2 independent standalone
  Shorts**, and **1 promotional Reel** (short-form destinations:
  YouTube Shorts, Instagram Reels, Facebook Reels, Snapchat Spotlight).
- **JARVIS legacy profile** (`jarvis_legacy_v1`): the existing planner
  contract (3 standalone Shorts with roles `opening_hook` 30 s /
  `high_tension_moment` 45 s / `cliffhanger_teaser` 30 s) preserved verbatim
  under `agent-01`'s default resolution until the owner explicitly decides
  otherwise. Existing JARVIS planner tests remain untouched and green.
- Explicit `profileId` override always wins over agent-default resolution, so
  a future owner-approved migration is a one-line change per agent.

## Contract

- `resolvePackageProfileForAgent(agentId)` → deterministic profile id
  (JARVIS → `jarvis_legacy_v1`; every other registered agent →
  `canonical_default_v1`); unknown/malformed agent ids fail closed.
- `buildPackageProfileManifest({ agentId, packageTaskId?, concept?,
  profileId? })` → frozen manifest with a recomputed SHA-256 `manifestId`
  over the fixed-key manifest content. Identical inputs produce
  byte-identical output; different inputs produce different ids.
- Invariant assertion: emitted outputs exactly match the profile counts
  (`PACKAGE_PROFILE_INVARIANT_VIOLATION` otherwise).
- Every manifest truthfully reports `mediaStatus: "not_generated"`,
  `providerCalls: []`, and `publication: { status: "not_requested" }` —
  publication is owner-gated (Rule 7) and never simulated here.

## Fail-closed behavior

| Situation | Stable error code |
|---|---|
| Unknown/malformed profile id | `PACKAGE_PROFILE_UNKNOWN` |
| Unregistered/malformed agent id | `PACKAGE_PROFILE_AGENT_INVALID` |
| Bad `packageTaskId` shape/length | `PACKAGE_PROFILE_TASK_ID_INVALID` |
| Concept too short/long/wrong type | `PACKAGE_PROFILE_CONCEPT_INVALID` |
| Secret-like free text (Rule 17) | `PACKAGE_PROFILE_SECRET_REJECTED` |
| Internal agent name in free text (Rule 15) | `PACKAGE_PROFILE_INTERNAL_AGENT_NAME_REJECTED` |
| Non-object input | `PACKAGE_PROFILE_INPUT_INVALID` |
| Profile/output count drift | `PACKAGE_PROFILE_INVARIANT_VIOLATION` |
| Tampered manifest content | `MANIFEST_ID_MISMATCH` |
| Malformed manifest to verify/serialize | `PACKAGE_PROFILE_MANIFEST_MALFORMED` |

## Tamper detection & serialization

- `verifyPackageProfileManifest(manifest)` recomputes the id and returns
  `{ ok: true }` or `{ ok: false, reasonCode }` — never throws on mismatch,
  never mutates.
- `serializePackageProfileForDashboard(manifest)` is a strict Rule-17
  allowlist projection (unknown fields dropped, identity re-verified before
  field validation, free text re-validated for Rules 15/17, frozen output,
  fixed key order). The free-text `concept` is deliberately **not** exposed
  on the dashboard DTO.

## Verification

`tests/packageProfileManifest.test.js` (19 tests) covers: registry shape and
freezing, destination allowlist, agent-default resolution (JARVIS legacy vs
canonical default), explicit override, unknown-profile/agent fail-closed
codes, canonical manifest content (1+2+1, destinations, runtime bounds),
JARVIS 3-Shorts preservation, publication/media truthfulness, freezing,
manifest-id recomputation, byte-identical determinism, id divergence,
secret/agent-name rejection, malformed inputs, the tamper matrix (outputs,
counts, destinations, publication, media), non-mutating verification, and
allowlist serialization with unknown-field drops.

Evidence from this slice: `npm test` 624/624 passing (19 new; existing JARVIS
planner suites untouched), `npm run verify`, `npm run lint`, and
`npm run plan:check` all pass on the slice branch.
