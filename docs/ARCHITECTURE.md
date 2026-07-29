# ST Production House Architecture

## Boundary

ST owns the control plane, policies, identity, credentials, jobs, evidence, approvals, affiliate links, and publishing intent. Specialized media systems run behind versioned worker contracts and cannot write ST's database directly.

```mermaid
flowchart TD
    UI["Owner dashboard"] --> CP["ST control plane"]
    CP --> DB["PostgreSQL policy and evidence"]
    CP --> Q["Durable job queue"]
    Q --> W["Isolated media workers"]
    W --> A["Verified artifact store"]
    A --> CP
    CP --> P["Postiz API service"]
```

## Agent Digital Identity and Account Isolation

To protect client privacy and ensure enterprise-grade security, agent names are strictly internal identifiers. No internal agent name (e.g., JARVIS, SHERLOCK, PANCHI, VEDA) may ever automatically appear in public-facing channels, captions, metadata, or media watermarks.

### Isolated Agent Connections
Each agent manages its own completely isolated, unconfigured workspace connections in the database:
- **Operational Email Connections**: Seeding one unconfigured slot per agent to handle future correspondence. Once configured, email addresses must be unique in a case-insensitive manner across agents.
- **Social Media Connections**: Seeding unconfigured slots for YouTube, Instagram, Facebook, and Snapchat.
- **Important Notice**: Real email addresses, live OAuth connections, and social accounts are NOT connected or active yet in this foundation. Live OAuth and social publishing remain pending.
- **Primary-Account Constraints**: An agent can have multiple non-primary accounts per platform, but only one primary account per platform. This rule is database-enforced using a partial unique index.

### Access Restrictions
- No agent can access or borrow another agent's credentials, OAuth tokens, email connections, or social channels. This prevents horizontal privilege escalation.
- Dashboard views use an explicit safe-output DTO/allowlist to ensure secret keys, locators, and unallowlisted fields are never serialized.

## Runtime rules

- An authenticated owner creates a task or promotion campaign.
- ST resolves the selected agent and that agent's task-scoped provider policy.
- Independent jobs may run in parallel. One job tries providers sequentially: primary, secondary, tertiary, then a local open-source emergency provider.
- Workers receive an opaque job-scoped secret handle, not stored credentials.
- A worker success requires an artifact hash and provider/renderer evidence.
- Publishing is blocked until the owner approves the exact immutable snapshot, binding valid public attribution. If no valid public brand/channel attribution is configured, publishing is immediately blocked with `PUBLIC_PUBLISHING_IDENTITY_REQUIRED`.
- Postiz returns actual platform results; ST stores their response hash and IDs.

## Concurrency

Use PostgreSQL `FOR UPDATE SKIP LOCKED` or a transactional queue. Leases must be time-bounded and reclaimable. Apply:

- a global worker limit;
- a per-agent limit;
- a provider/account rate limit;
- GPU/CPU resource pools;
- idempotency keys and dead-letter queues.

Parallelism happens across agents and jobs. Provider fallback for a single task is sequential to avoid duplicate cost and conflicting outputs.

## Promotions

The database owns a unique `product_identities.identity_sha256`. One `promo_reels` row may reference that identity. Render failures add `promo_reel_versions`; they never create another logical Reel.

Duplicate campaigns are separate business records and require explicit owner authorization. They cannot bypass the unique Reel rule.

Main-video promotion is a separate placement record. Intake must always ask the owner whether to include it and, if yes, which episode.

Affiliate links are campaign/platform placements, not new videos. Every link requires an allowlisted HTTPS domain, disclosure, redirect/SSRF inspection, malware screening, expiration policy, and owner approval.
