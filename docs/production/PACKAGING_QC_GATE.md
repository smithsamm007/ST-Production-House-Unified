# Packaging stages + QC gate (Issue #185)

> Status: implemented. The episode pipeline now runs two post-assembly
> stages — `packaging` (thumbnail media, subtitle/metadata documents, episode
> package manifest) and `qc` (gate over the recorded manifest + artifacts).
> Everything records through the existing persistence paths: media through
> the #182 bridge, documents content-addressed.

## Stages

    assembly (verified main video, #183)
      └── packaging
            ├── thumbnail media   — runner-driven, bridge-evaluated + recorded
            │                       (ffprobe-verified image artifact)
            ├── subtitle document — deterministic, content-addressed record
            ├── metadata document — deterministic, content-addressed record
            └── episode package manifest — binds the release's OWN recorded
                artifacts + documents; identity (manifestId) recomputed at
                record time and re-checked by the gate
      └── qc
            ├── automated verdicts now: approved / rejected
            └── needs_human verdicts: durable, release lands in `review`
                (the owner gate); a future human decision is RECORDED via
                recordHumanQcDecision, never auto-derived

`src/pipeline/packagingQc.js` is the module boundary; `runEpisodePipeline`
invokes it after the assembly stage and before the story stage. The new
stage names extend the `pipeline_events.stage` CHECK via additive migration
`sql/024` (drop + re-add, sql/009 precedent; idempotent).

## Honesty contract

- Documents carry the release's own planned text verbatim; the manifest
  binds REAL recorded hashes. Nothing is "generated" that was not produced.
- Thumbnail media can only record through the bridge's verified path — a
  hand-forged `VERIFIED` descriptor without a real matching inspection
  throws (`EXECUTOR_DESCRIPTOR_INVALID`).
- The gate recomputes integrity from content: manifest identity, document
  hashes, artifact binding equality, media verification states. Missing
  artifacts throw (`QC_ARTIFACT_MISSING`) — never an automatic pass.
- Waits/failures mirror #183: a thumbnail quota/credential wait is durable
  (release → `planned`, `pipeline_stage_waiting` evidence, wait attached to
  the job without changing its status per R5); failures preserve recorded
  earlier stages.

## QC gate checks (pipeline-authoritative, in order)

| Check | Fails with |
|---|---|
| `MANIFEST_INTEGRITY` | `QC_MANIFEST_INVALID` (identity recompute), `QC_DOCUMENT_TAMPERED` (recorded content mismatch) |
| `MEDIA_VERIFICATION` | `QC_ARTIFACT_MISSING` (binding ≠ recorded), `QC_MEDIA_NOT_VERIFIED` (unverified binding) |
| `DOCUMENT_INTEGRITY` | `QC_DOCUMENT_TAMPERED` (stored content recompute) |
| `AGENT_SCOPE` | `QC_AGENT_SCOPE_MISMATCH` (cross-Director binding) |
| `RUNNER_CHECKS` | runner reason, or `QC_HUMAN_REVIEW_REQUIRED` → `needs_human` |

Runner checks are optional injected policy (`{ name, passed }` or
`{ name, requiresHuman: true }`); their absence never weakens the gate.

## Human-in-the-loop

`needs_human` is a first-class verdict: the gate decided nothing; the
release waits in `review`. `recordHumanQcDecision({ verdict, decidedBy })`
records an explicit human `approved`/`rejected` decision bound to the
manifest id and deciding principal — never derived, never inferred.

## Director isolation (Master Prompt §3/§4)

Inputs, documents, manifests, verdicts, and decisions are bound to
`release.agentId` (resolved durably via release → channel → agent in
#183/#184). Cross-Director artifacts fail at packaging
(`PACKAGING_AGENT_SCOPE_MISMATCH`) and at the gate (`QC_AGENT_SCOPE_MISMATCH`).
The module is stateless — no caches, no cross-release context.

## Tests

- `tests/packagingQc.test.js` (19): deterministic inputs, content-addressed
  documents + tamper detection, manifest binding/identity, scope fail-closed
  paths, end-to-end packaging, durable wait/failure shapes, forged-thumbnail
  rejection, all gate verdicts (approved/rejected/needs_human), human
  decision recording, error-code closure.
- `tests/executorPipelineIntegration.test.js` (+3): pipeline-level
  needs_human → `review` with recorded verdict artifact, QC rejection →
  truthful stage failure, packaging thumbnail quota wait → durable wait with
  earlier stages preserved.
