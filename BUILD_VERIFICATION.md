# Build Verification

Date: 2026-07-29  
Environment: local scratch workspace  
Live providers contacted: none  
Publishing actions performed: none  
Secrets used: none

## Command

```bash
npm run verify
```

## Result

- JavaScript syntax checks: passed
- Test files: 6
- Tests: 40 passed, 0 failed, 0 skipped
- Duration reported by Node test runner: 318.520152 ms

## Verified policies

- Canonical 20-agent preload and 50-agent cap.
- Cross-agent credential access rejection.
- Sequential three-provider fallback to a keyless local emergency provider.
- Provider success evidence requirements.
- Product/service identity normalization.
- Owner permission for duplicate campaigns.
- One standalone Reel per normalized product/service.
- Independent, explicit main-video promotion.
- Affiliate HTTPS, disclosure, and domain allowlist requirements.
- Rejection of fabricated publishing receipts.
- Dry-run publishing without fake platform IDs or URLs.
- **Agent Digital Identity and Account Isolation (Task 6)**:
  - Supported platforms: youtube, instagram, facebook, snapchat.
  - Safe dashboard DTO/allowlist serialization (zero credentials or secret locator leakages).
  - Public attribution strictly rejects internal agent names (JARVIS, LAKME, VEDA).
- **Agent Creative Charter and Channel Universe System (Task 7)**:
  - Additive migrations for creative universes, charters, assignments, entities, claim classifications, and approvals.
  - JARVIS initial active Hindi/Hinglish connected horror cinematic universe charter vision.
  - LAKME initial active Hindu Mythology universe charter vision (Samay as narrator, claim safety classifications).
  - LAKME lazy hierarchy resolving node paths dynamically without database row explosion.
  - Immutable version snapshots, dynamic approval SHA-256 hash checks, and duplicate activation block rules.
- **Niche Reference and Visual Reference Library (Correction Upgrade)**:
  - Additive migrations for creative_references, niche/visual profiles, scope assignments, and approval references.
  - YouTube allowlist verification and unsafe URL parsing blocks (rejections of non-standard ports, credentials, localhost, private IPs, unapproved domains).
  - Canonicalization of equivalent YouTube URLs to detect and prevent duplicates.
  - Manual profiles requiring owner approval bound to SHA-256 hashes.
  - Verification that niche characteristics do not alter visuals, and visual characteristics do not alter story or narration.

This verifies the secure policy foundation only. It is not evidence that live provider adapters, media rendering, platform uploads, the dashboard, or the production deployment are complete.
