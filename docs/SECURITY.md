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

## Agent Creative Charter and Reference Library Security

To safeguard creative vision, long-term brand equity, and prevent snapshot tampering:
- **Approval Binding**: Owner approvals bind to the exact version snapshot and its SHA-256 hash. Any modification, replacement, or re-assignment to another agent immediately invalidates the approval.
- **Assignment Uniqueness**: The database schema strictly guarantees at most one active charter assignment per agent (via partial unique index) and at most one active version per charter.
- **Niche vs Visual Isolation**: Strict security separation of niche characteristics and visual characteristics prevents design decisions from silently controlling stories or characters, and prevents story rules from silently hijacking visuals.
- **URL Sanitization & Allowlist Policy**: Rejects non-standard ports, localhost, embedded credentials, and non-allowlisted domains. Only canonicalized YouTube URL formats are permitted inside the system, with duplicate detection blocking equivalent URL profiles.

## Owner-Agent Communication Studio Security

The Owner-Agent Communication Studio ensures maximum protection during blueprint drafting and onboarding:
- **Zero-Trust Sender Authorization**: Active session messaging threads validate sender roles against a strict message type matrix, preventing cross-tenant thread injection and message spoofing.
- **Brand Safety Analysis**: Automated brand safety checks block validation of blueprints that include terms of concern like 'unsafe' or 'unfiltered'.
- **Recursive Credential Scrubbing**: Blueprint version snapshots undergo recursive deep-scanning to eliminate API keys, access tokens, passwords, or credential-shaped objects from ever being persistent.
- **Immutable Approval Locking**: Once an exact version snapshot is approved by the owner, any modifications to the blueprint draft are blocked, previous versions are superseded, and the blueprint is permanently frozen.

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

## Hermes Manager Layer (decision authority without secret access)

The Hermes manager layer (`/api/hermes/*`, `src/manager/*`) holds decision authority, never unrestricted access:

- **Frozen authority matrix** — autonomous production/scheduling/provider decisions; owner-policy-controlled publishing, deletion, and spending; structurally prohibited secret access, security-control changes, and audit-ledger modification. Unknown actions fail closed; prohibited actions cannot be executed even with an approval. Refusals (`BLOCKED`) are recorded as audit evidence.
- **Secret-free by construction** — decision payloads are validated recursively server-side: secret-named fields and secret-shaped values are rejected before a record exists. Hermes addresses credentials by REFERENCE only (`agent-01 / gemini / production`); the credential broker delivers material directly to the authorized adapter. Records serialize through an explicit DTO allowlist.
- **Append-only, honestly completed decisions** — records are immutable; completions supersede rather than mutate. `EXECUTED` requires a ledger-verified evidence receipt; unverified success is recorded as `FAILED`/`EVIDENCE_UNVERIFIED` (Rule 1). Every mutation requires CSRF and writes an audit event.
- **Isolated execution bridge** — `production.start` decisions queue work ONLY through the owner API's transactional path, guarded by director↔channel tenant isolation (`DIRECTOR_CHANNEL_MISMATCH`): a decision may never queue work for one director under another's channel identity (Rule 5). Publishing stays owner-policy controlled; the bridge queues, it never publishes. Terminal decisions (`BLOCKED`/`FAILED`/`EXECUTED`) are refused without rewriting their recorded outcomes.

## Secrets & Connections (per Director)

The owner dashboard's Secrets & Connections surface (sql/022, `/api/providers/*`, `/api/connections/*`) stores per-director provider bindings under three data classes:

- **Secrets** are OPAQUE LOCATORS only. The database trigger rejects any `secret_fields` value that is not `vault://…` or `opaque://…`, so plaintext API keys are structurally impossible to persist; the repository re-validates before every write (defense in depth). Locator values never serialize — DTOs expose field KEYS only.
- **Configuration** fields are non-secret, bounded strings, and are prohibited from smuggling locator-shaped values.
- **Provider connection metadata** is a frozen catalog with official HTTPS-only credential URLs (validated against localhost/private-IP/embedded-credential/port rules); owners may register custom providers through the same safety bar without mutating the governed catalog.

Connection tests are honest by construction: without an owner-configured live transport they record `unverified` — never `success` (Rules 1–3). Test history is append-only (mutation-blocking trigger) and failure details are sanitized so locators and secret-shaped strings never reach the audit trail. Every read and write is scoped by owner AND director; cross-tenant access is a generic 404.

If public publishing is attempted but no active primary brand or primary social channel attribution is configured, publishing is blocked with a `PUBLIC_PUBLISHING_IDENTITY_REQUIRED` error.

## Adversarial Hardening (TASK-2.8)

The following surfaces are continuously exercised by the offline adversarial suite in `tests/adversarial/`, which runs as part of `npm test`:

- **Locator fuzzing (`fuzz-locators.test.js`)** — mutated locator strings (oversized inputs, hostile unicode, traversal and injection-shaped payloads) never crash the parser unhandled and never leak raw input material in error responses beyond the locator's own short version tag.
- **API header and body fuzzing (`api-header-fuzz.test.js`)** — oversized and malformed `Authorization` headers, hostile cookies, injected auxiliary headers, hostile query strings, oversized/malformed JSON bodies, and unknown routes always produce clean 4xx responses from the owner API. Error bodies are drawn from a fixed public error-code allowlist; no stack traces, SQL fragments, or reflected input are returned. A valid bootstrap token still authenticates after the gauntlet (no false lockout).
- **SQL injection matrix (`sql-injection-matrix.test.js`)** — classic injection payloads (`' OR 1=1 --`, `'; DROP TABLE`, UNION SELECT, stacked statements, JSON/boolean/time-based shapes) are pushed through every credential, audit, and quota repository function and asserted to arrive as bound parameters; nothing is interpolated into SQL text.
- **Body parse errors fail closed** — malformed or oversized JSON is handled by a dedicated body-parser error handler in the owner API so it yields a clean 4xx instead of surfacing as a 500 from the global error path.
- **Checkpoint replay is scope-bound** — durable `WAITING_FOR_QUOTA` checkpoints reject resume attempts from foreign owners (`SCOPE_MISMATCH`), so a leaked checkpoint id cannot be replayed across tenants.

Operational response guidance for these surfaces lives in `docs/RUNBOOK.md` (alert triage, emergency pause, rotation drill, migration rollback policy).

## Durable Recovery Semantics

- A restarted worker detects completed stages from the checkpoint store and never regenerates or republishes finished artifacts; duplicate prevention is enforced by checkpoint replay, not operator discipline.
- Quota exhaustion across the full provider chain produces a truthful `WAITING_FOR_QUOTA` checkpoint (`APPROVED_FREE_CAPACITY_UNAVAILABLE`, execution not started, provider selection not performed) rather than a fabricated success or silent skip.
- The full acceptance chain — provider exhaustion, secondary and open-source fallback attempted, all-capacity-unavailable checkpoint, scheduler resume after quota reset, artifact produced exactly once, no duplicate generation — is demonstrated by `tests/waitingForQuotaAcceptance.test.js`.
