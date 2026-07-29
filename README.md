# ST Production House Unified

This is a clean, ST-owned secure foundation for consolidating the strongest ideas from the supplied repositories without merging their vulnerabilities, simulations, duplicate pipelines, or legally uncertain assets.

## What is implemented

- **Agent Creative Charter and Channel Universe System (Added Upgrade)**:
  - Supports versioned, owner-controlled Creative Charters and Channel Universe registries.
  - Keeps the internal agent names (e.g. JARVIS, LAKME, PANCHI, VEDA) strictly separated from public channel brands, creative universes, narrator identities, and public attribution.
  - Internal names are strictly blocked from public exposure.
  - Initially, only JARVIS and LAKME possess active owner-approved Creative Charters. The remaining 18 preloaded agents remain unassigned and inactive, ensuring no fake details are generated.
  - LAKME's Hindu Mythology universe implements a highly performant **Lazy Hierarchy** (Universe → Era or Yuga → Source Collection → Series → Season → Story Arc → Episode), allowing more than 8,000 episodes to be resolved on demand without pre-creating millions of empty database rows.
- **Agent Digital Identity and Account Isolation**:
  - Every agent name is used as an internal identifier only. Public publishing strictly uses the connected channel/account brand.
  - Every agent possesses unconfigured account slots for emails, YouTube, Instagram, Facebook, and Snapchat. Real email addresses, live OAuth connections, and social accounts are not active yet.
  - Safe dashboard serialization uses an explicit safe DTO/allowlist to ensure secret keys and locators are never serialized.
- Owner-controlled canonical 20-agent catalog, with a hard maximum of 50.
- Strict per-agent provider policy: three private remote providers and one keyless local open-source emergency provider.
- Evidence-bearing failover that rejects unverified "success".
- Persistent PostgreSQL design for credentials, jobs, leases, provider attempts, artifacts, campaigns, approvals, affiliate links, and receipts.
- One standalone promotional Reel per normalized product/service identity.
- Explicit duplicate-campaign authorization and independent main-video choice.
- Affiliate HTTPS/domain/disclosure policy.
- Owner-approved publishing snapshots with cryptographically hashed snapshots to prevent post-approval mutations.
- Isolated worker contracts for story, motion, assembly, and Postiz publishing.
- Automated policy tests requiring no package installation.

## What is deliberately not claimed

Live Gemini, Claude, Sarvam, Veo, social-network, Snapchat, or Postiz calls are not enabled in this foundation. Those require the owner's accounts, secret-manager references, provider sandbox verification, and platform approval. No uploads or provider calls were made while building this repository.

Snapchat is supported as an account configuration type, but live Snapchat publishing remains pending.

All email and social connection slots are currently unconfigured and seeded with null identifiers in the database.

No actual episodes, characters, stories, platform accounts, or public channel names are generated in this task. We implement only the secure foundation and initial owner-approved charter records.

## Verify

Requirements: Node.js 20 or newer.

```bash
npm test
npm run verify
```

## Next steps

Read:

- `docs/ARCHITECTURE.md`
- `docs/REPOSITORY_AUDIT_AND_REUSE.md`
- `docs/SECURITY.md`
- `docs/IMPLEMENTATION_ROADMAP.md`
- `AGENTS.md`

Apply `sql/001_core.sql`, `sql/002_seed_agents.sql`, `sql/003_agent_digital_identity.sql`, and `sql/004_creative_charter.sql` to a new PostgreSQL database only after replacing the example credentials and adding backups.

The recommended first implementation increment is the authenticated API, PostgreSQL repositories, durable worker leases, and a secret-manager broker.
