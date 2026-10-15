# Release Certification & SBOM (TASK-5.3, Phase 5)

Real, offline-verifiable release evidence generated from the actual
repository state only — no network calls, no fabricated receipts
(AGENTS.md Rules 1–3). Run with:

```sh
npm run release:certify        # writes artifacts/release/{sbom.cdx.json, release-certification.json}, exit 0 only on PASS
```

## What is certified

1. **SBOM (CycloneDX 1.5-shaped)** — every packaged dependency from the real
   `package-lock.json`: name, exact version, scope (`production`/`dev`), and
   its DECLARED license. A package with a missing/empty license declaration
   fails closed (`SBOM_LICENSE_UNKNOWN`) — declaration gaps are surfaced,
   never guessed.
2. **License policy gate** — permissive default allowlist (MIT, ISC,
   BSD-2/3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0); copyleft or
   unknown licenses fail closed listing every offender
   (`RELEASE_LICENSE_POLICY_DENIED`); explicitly documented exception maps
   authorize named licenses only.
3. **Rule 12 bundled-media scan** — recursive walk over the deployed source
   roots (`src/`, `public/`, `scripts/`, `docs/`, `tests/`, `automation/`)
   for third-party media/fonts/model-weight asset extensions; any finding is
   listed and fails closed (`RULE12_BUNDLED_MEDIA_FOUND`) unless documented
   in a supplied manifest. A missing optional root is reported as absent —
   never silently assumed clean.
4. **Deterministic certification record** — verdict object
   (`sbomInventory`, `policy`, `bundledMedia`, `overallVerdict`) whose
   `releaseCertificationId` is SHA-256 over content only (lockfile digest,
   package manifest digest, components, verdicts; no timestamps), so the
   same release content certifies to the same id.

## Executed evidence (2026-10-15)

- `RELEASE_CERTIFICATION_PASS` — 114 components, license summary
  `MIT 104 / ISC 9 / BSD-3-Clause 1`, zero license-policy denials,
  **zero bundled media findings** (Rule 12 clean), exit 0.
- Evidence JSON in git-ignored `artifacts/release/` (produced by running the
  tool, never committed as a claim).

## Honest limitations

- Negative licenses values in lockfiles are only as accurate as the upstream
  metadata stream allows; for a redistribution-grade review, also verify
  licenses against the upstream project declarations. This tool certifies
  the repository's declared state and fails closed on gaps.
- Non-allowed licenses are not blocked from working — the gate's job is to
  make the verdict and offender list impossible to miss before release.
