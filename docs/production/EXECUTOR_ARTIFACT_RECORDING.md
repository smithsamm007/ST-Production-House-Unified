# Executor artifact recording bridge (Issue #182)

> Status: implemented (offline-verifiable recording contract). The bridge
> performs NO provider calls and NO media generation. It records the results
> of REAL executors (TTS #177, visual #181, assembly #174) into the canonical
> `artifacts` table with honest provenance — and refuses to persist anything
> that fails its gates.

## Purpose

Before this slice, the episode pipeline's `artifacts` path had exactly one
persistence mode: `generationMode: "deterministic_local"` with
`ffprobe_verified = false` hardcoded and a `local://deterministic/...`
storage URI. Real executor results (verified TTS narration, verified visual
frames, verified assembly renders) could therefore not be recorded without
either falsifying their provenance or bypassing the artifacts table.

`src/pipeline/episodePipeline.js` now exposes the recording bridge:

    executor result (tts/visual/assembly)
      └── projectExecutorResult()      — inbound Rule-17 allowlist
      └── evaluateExecutorArtifact()   — fail-closed gates → honest verdict
      └── recordExecutorArtifact()     — idempotent persistence

## Gates (fail-closed, stable codes)

| Gate | Code | Meaning |
|---|---|---|
| Result shape | `EXECUTOR_RESULT_MALFORMED` | Non-object result; success without descriptor; descriptor result missing identity anchor |
| Forgery | `EXECUTOR_DESCRIPTOR_INVALID` | A `VERIFIED` descriptor without a real matching-hash successful inspection — hand-forged verification can never be recorded |
| Identity | `EXECUTOR_DESCRIPTOR_INVALID` | Missing/non-hex `contentSha256`; unknown verification state |
| Isolation | `EXECUTOR_AGENT_SCOPE_MISMATCH` | Descriptor producer agent differs from the release's Director |
| Scope | `EXECUTOR_STAGE_MISMATCH` | Unknown stage or release without an agent binding |
| Outcome integrity | `EXECUTOR_OUTCOME_TAMPERED` | Recorded outcome missing its contract type marker |

Codes are exported as `EXECUTOR_ARTIFACT_ERROR_CODES` (closed set).

## Truthful verdicts

- **Honest success** — `VERIFIED` descriptor + real matching inspection →
  `verified: true`, `generationMode: "provider_generated"`, real content
  hash; recorded with `ffprobe_verified = true`.
- **Honest unverified** — executor ran but inspection failed → recorded as
  `not_evidenced` with `ffprobe_verified = false`; the original failure code
  is preserved. Exit 0 is never success.
- **Honest waiting** — `WAITING_FOR_QUOTA` / credential absence → no media
  hash is fabricated; the wait is a durable, resumable state for the
  scheduler, never an artifact.

## Provenance changes in `ProductionRepository.recordArtifact`

- `generationMode` now derives from the allowlisted payload (callers that do
  not supply one keep `deterministic_local` — existing behavior unchanged).
- `ffprobe_verified` is caller-supplied truth, defaulting to `false`.
- `storage_uri` names the ACTUAL mode (`local://provider_generated/...` vs
  `local://deterministic_local/...`) — still an honest local descriptor,
  never a fabricated platform URL.
- Executor evidence fields (`executorVerified`, `quotaState`,
  `failureCode`) are allowlisted into metadata; unknown payload fields are
  dropped.

Idempotency is unchanged: identical `(release_id, sha256)` is stored once.

## Tests

`tests/executorArtifactRecording.test.js` (12 tests): allowlist projection,
malformed rejection, forgery gates (no inspection / different-bytes
inspection), cross-Director isolation, unknown-stage and missing-release
rejection, verified/unverified/waiting verdicts, real persistence through
`ProductionRepository` (provider_generated + ffprobe_verified=true vs
deterministic defaults unchanged), and content-idempotent re-recording.

## Non-goals

No provider calls, no stage orchestration changes, no publishing. The
executor-to-pipeline worker loop (invoking real executors inside
`runEpisodePipeline` with durable checkpoints) is the next slice and must
consume this bridge rather than writing artifacts directly.
