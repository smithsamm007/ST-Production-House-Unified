# Visual generation execution worker (Issue #180 — S-M35 execution slice)

> Status: implemented (real execution boundary with injected transports).
> The executor performs REAL provider execution and REAL post-generation
> verification in production. The offline test suite proves the contract via
> injected `spawnImpl`/`readFileImpl` transports — no network, no binaries.
> No claim of live provider availability is made: live provider onboarding
> remains an owner-gated slice (S-M20-LIVE).

## Purpose

`src/media/visualExecutor.js` is the worker boundary that turns a validated
S-M35-01 visual contract record into real media, mirroring the proven TTS
executor (Issue #177):

    style profile (visual_style_profile_v1) + generation request
      └── executeVisualGeneration()
            ├── verifyVisualStyleProfile()   — tamper gate (S-M35-01)
            ├── request id re-computation    — tamper gate on the request
            ├── selectVisualProvider()       — contract tier chain, quota-aware
            ├── buildPollinationsArgs /
            │   buildLocalVisualArgs         — ARRAY ARGS ONLY (Rule 2)
            ├── runVisualProvider()          — injectable spawn, no shell
            ├── inspectMediaFile()           — real bytes → hash + ffprobe (#170)
            ├── verifyArtifactDescriptor()   — S-M30-01 promotion
            └── recordVisualGenerationOutcome() — S-M35-01 truthful outcome

## Contract chain (free-first, never reordered)

| Tier | providerId     | Role                          | command             | authType |
|------|----------------|-------------------------------|---------------------|----------|
| 1    | `pollinations` | approved_free_primary         | `visual-pollinations` | none   |
| 4    | `local-sd`     | local_open_source_emergency   | `visual-local`      | none      |

Paid image/video services are deliberately absent: the automatic production
chain never routes to a paid provider. Each chain entry declares the
modalities it can serve (`pollinations`: image/still_acquisition; `local-sd`:
all four modalities including motion). Only DECLARED capabilities from the
injected registry are selectable; a modality or aspect ratio the declaration
does not claim is never chosen, and every skip is recorded with an honest
reason in `attempts[]`.

## Honesty contract (Rules 1–3)

- A provider call that merely exits 0 is NOT evidence of media. The written
  file is hashed from its actual bytes and probed by ffprobe; only a
  matching-hash inspection promotes the descriptor (S-M30-01), which alone
  produces `mediaStatus: "verified"` / `generationMode: "provider_generated"`.
- `WAITING_FOR_QUOTA` is the durable, resumable state when no provider can
  serve the request (quota exhaustion or missing credentials) — never a
  disguised failure or fabricated success. Credential absence is surfaced as
  `CREDENTIAL_MISSING`, distinct from provider quota (`QUOTA_EXHAUSTED`).
- Every failure is truthful and stable-coded: `PROVIDER_UNAVAILABLE`,
  `VISUAL_TIMEOUT`, `PROVIDER_CALL_FAILED`, `CREDENTIAL_MISSING`,
  `QUOTA_EXHAUSTED`, `VISUAL_OUTPUT_PATH_UNSAFE`, `VISUAL_PROMPT_INVALID`,
  `VISUAL_MODALITY_INVALID`, `VISUAL_REQUEST_INVALID`/`_TAMPERED`,
  `VISUAL_PROFILE_INVALID`/`_TAMPERED`, `VISUAL_SPAWN_FAILED`,
  `INSPECTION_FAILED`.
- Tampered style profiles and tampered requests never execute (id
  recomputation gates); cross-Director request/profile bindings fail closed
  before any spawn.

## Safety

- Spawn uses array arguments ONLY (CONVENTIONS Rule 2 — never a shell
  string). The visual prompt travels via STDIN, never argv, mirroring the
  TTS executor's piper discipline. Output paths are validated (no NUL, no
  leading dash, no `..` traversal segments, bounded length) before any argv
  is derived. Model paths are validated as artifact paths.
- Transports are injectable so tests prove the contract offline; production
  binds node:child_process spawn (array args, shell:false) and
  node:fs/promises. The module adds no new dependencies.
- R15/R17: the prompt validator rejects secret-shaped strings and internal
  agent names; descriptors carry agent ids only; no secrets serialized.

## Outcome matrix

| Provider call | Descriptor state | Result.success | mediaStatus | generationMode |
|---|---|---|---|---|
| exit 0 + matching ffprobe inspection | VERIFIED | true | verified | provider_generated |
| exit 0, unreadable/unprobed file | UNVERIFIED | false | unverified | not_evidenced |
| non-zero exit / timeout / absent binary | — | false | unverified | not_evidenced |
| no selectable provider | — | false | unverified | not_evidenced (quotaState = WAITING_FOR_QUOTA) |

## Descriptor binding

The descriptor is created from the REAL measured hash — no claimed
dimensions or durations are asserted. `artifactType` derives from the
request modality (image/still_acquisition → `image`; video_clip/animation →
`video`); MIME types are the canonical per-modality types (image/png,
image/jpeg, video/mp4). `producer.stageId` is `visual`; `producer.providerId`
is the selected chain provider.

## Non-goals

No live provider credential onboarding (owner-gated), no storage, no
scheduling, no publishing. The execution adapter consumes the S-M35-01
contract plus real provider responses and real inspections; live provider
availability is claimed only after the owner connects real credentials
through the Secrets & Connections surface.
