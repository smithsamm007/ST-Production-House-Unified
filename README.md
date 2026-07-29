# ST Production House Unified

This is a clean, ST-owned secure foundation for consolidating the strongest ideas from the supplied repositories without merging their vulnerabilities, simulations, duplicate pipelines, or legally uncertain assets.

## What is implemented

- **Agent Digital Identity and Account Isolation (Upgraded Foundation)**:
  - Every agent (including JARVIS, SHERLOCK, PANCHI, VEDA, etc.) uses its name as an **internal identifier only**. Internal agent names are strictly blocked from automatically appearing in public videos, watermarks, captions, descriptions, promotional Reels, or social posts.
  - Public publishing strictly uses the connected channel/account brand.
  - Every agent possesses unconfigured account slots for:
    - Operational email connection
    - YouTube channel connection
    - Instagram account connection
    - Facebook Page connection
    - Snapchat account connection (supported but live integration is pending)
  - **Important Notice**: Real email addresses, active OAuth connections, and live social accounts are NOT connected or configured yet in this Phase-1 foundation. Live OAuth, external network connections, and publishing remain completely pending.
  - Access controls prevent any agent from accessing another agent's connections, OAuth tokens, or provider credentials.
  - Safe dashboard serialization uses an explicit safe DTO/allowlist to ensure unknown or private fields are never serialized automatically.
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

Apply `sql/001_core.sql`, `sql/002_seed_agents.sql`, and `sql/003_agent_digital_identity.sql` to a new PostgreSQL database only after replacing the example credentials and adding backups.

The recommended first implementation increment is the authenticated API, PostgreSQL repositories, durable worker leases, and a secret-manager broker.
