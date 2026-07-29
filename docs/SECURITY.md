# Security Baseline

## Authentication and authorization

- Owner accounts use Argon2id password hashes, optional passkeys, MFA, secure HttpOnly/SameSite cookies, session rotation, and short idle expiry.
- Missing or invalid authentication is always HTTP 401. It never creates an implicit owner.
- Mutations require CSRF protection and role/capability checks.
- Rate-limit login, provider, rendering, and publishing routes.

## Agent Digital Identity and Account Isolation

To achieve true zero-trust compartmentalization within multi-agent environments:
- **Internal Agent Anonymity**: Agent names are strictly mapped to UUIDs or internal primary keys. No internal name (e.g. VEDA) is exposed in public caption payloads, platform descriptions, or media renderings. This includes strict normalization checks against names containing underscores, hyphens, and periods (such as `AGENT_NAME_35`).
- **Account Isolation**: YouTube channel connections, Facebook Pages, Instagram accounts, Snapchat accounts, and operational email pipelines are isolated. Tokens, credentials, and connection descriptors belonging to Agent A are strictly protected against lookup or modification by Agent B.
- **Important Notice**: No real email addresses, active OAuth credentials, or live social accounts are configured in this Phase-1 foundation. All slots remain unconfigured and live social publishing/OAuth integration is pending.
- **Strict Data Sanitization**: To prevent leakage of cloud references or authentication material, the control plane sanitizes all serialized JSON payloads before sending them to browser code using an explicit safe-output allowlist (DTO), blocking any unallowlisted or unexpected fields from being serialized automatically.

## Agent Creative Charter Security and Version Integrity

To safeguard creative vision, long-term brand equity, and prevent snapshot tampering:
- **Approval Binding**: Owner approvals bind to the exact version snapshot and its SHA-256 hash. Any modification, replacement, or re-assignment to another agent immediately invalidates the approval.
- **Assignment Uniqueness**: The database schema strictly guarantees at most one active charter assignment per agent (via partial unique index) and at most one active version per charter.
- **Sanitized Worker Context**: When running isolated worker engines, the context dynamically restricts exposed keys. It can contain the internal `agentId` for authorization tracking, but absolutely prohibits credential references, secrets, or API keys.

## Credentials and Reference Architecture

The database stores only opaque secret-manager locators (e.g., `vault://st/agents/agent-01/providers/gemini/primary`). A worker obtains a short-lived, task-scoped credential from a trusted broker. Credential audit logs record the agent, task, slot, provider, and outcome—but never the secret.

No agent may access another agent's locator. The local emergency provider has no remote shared key.

### OAuth Token Expiry and Reauthentication
- Credentials and OAuth connections monitor token lifetime via `token_expires_at`.
- When an expiration window is crossed, the system flips `reauthentication_required` to `true` and blocks further worker jobs until an owner performs a re-auth workflow.

## Media and URLs

- MIME sniff uploads, enforce byte/duration/resolution limits, virus scan, and store outside the web root with random object names.
- Invoke FFmpeg through argument arrays, resource limits, and sandboxed workers.
- Verify actual output using FFprobe and SHA-256; never fabricate metadata.
- Affiliate/import URLs must use HTTPS, pass a domain allowlist, resolve outside private/link-local/loopback ranges, cap redirects, and pass phishing/malware screening.

## Publishing

Default mode is draft/private. Approval binds owner, artifact hash, caption, affiliate disclosures, destination, schedule, and expiry. Any mutation after approval invalidates it. Only a platform response can create a publish receipt.

If public publishing is attempted but no active primary brand or primary social channel attribution is configured, publishing is blocked with a `PUBLIC_PUBLISHING_IDENTITY_REQUIRED` error.
