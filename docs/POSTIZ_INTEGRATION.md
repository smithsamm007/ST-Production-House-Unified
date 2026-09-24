# Assessment & Integration Record: Postiz (postiz-org/postiz-app)

Assessment date: **2026-09-24**. Contract Rule 11: Postiz remains a separately
deployed AGPL service accessed only through its API. Nothing upstream is
pasted into this repository (Rule 10).

## Verdict

**External publishing gateway behind an adapter — never an in-repo dependency.**
Postiz can relay owner-approved posts to configured social destinations, but
it cannot self-certify results: a Postiz "accepted" response only counts as a
publish when the ST evidence ledger confirms the receipt (Rule 1).

## What this repo now contains

- `src/integrations/postizAdapter.js` — pure boundary module, no network I/O:
  - Frozen provenance record (AGPL-3.0, separate deployment,
    `copiedSourceFiles: 0`).
  - Envelope validation fail-closed on missing jobId / tenant / destination /
    caption / media fields; platform restricted to the ST enum
    (`youtube | instagram | facebook | snapchat`).
  - Tenant isolation per Rule 5 (one agent, one task slot) with the same
    tenant model as the AgentTube adapter.
  - Owner-approval gate (Rule 7): dispatch refuses a missing or expired
    approval, using injectable `now` so tests stay deterministic.
  - Outbound payload allowlist (Rule 15/17): only
    `publicAttribution, caption, platform, mediaUri, mediaSha256, disclosure`
    serialize — internal agent names, IDs, namespaces, and secret-shaped
    fields are structurally incapable of reaching Postiz.
  - Immutable adapter registry (registration returns a NEW frozen registry).
  - Evidence-gated dispatch (`runPostizDispatch`): success requires a
    ledger-verified receipt and produces a `validateWorkerResult`-compliant
    result reusing the existing worker lifecycle — no new status states (R5).
- `tests/postizAdapter.test.js` — 26 offline unit tests covering validation,
  approval gating, payload allowlisting (Rule 15 leak-proofing), registry
  immutability, the evidence gate (missing/unverified/failed lookups), and
  failure propagation without swallowing.

## What was NOT done, deliberately

- No upstream code was merged or copied into ST.
- No network calls, no env reads, no new dependencies, no SQL changes.
- No live Postiz deployment, tokens, or destinations are configured; nothing
  publishes. Live publishing remains owner-gated per Rules 7/16.
- No analytics or engagement features — those depend on live publishing.

## Deployer responsibilities (when the owner enables live publishing)

1. Deploy Postiz separately (Rule 11) with its own hardening review.
2. Store the Postiz base URL and token in the secret manager; per-agent task
   slots reference opaque locators only (Rules 4–5, 17) — never this module.
3. Implement the actual `run(payload)` transport in the deployer's runtime;
   every real call must write an evidence-ledger row the ST ledger can verify.
4. Keep the owner approval flow (Rule 7) upstream of any dispatch; the
   adapter enforces it, but the approval itself must come from the owner.
