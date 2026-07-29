# Security Baseline

## Authentication and authorization

- Owner accounts use Argon2id password hashes, optional passkeys, MFA, secure
  HttpOnly/SameSite cookies, session rotation, and short idle expiry.
- Missing or invalid authentication is always HTTP 401. It never creates an
  implicit owner.
- Mutations require CSRF protection and role/capability checks.
- Rate-limit login, provider, rendering, and publishing routes.

## Credentials

The database stores only opaque secret-manager locators. A worker obtains a
short-lived, task-scoped credential from a trusted broker. Credential audit logs
record the agent, task, slot, provider and outcome—but never the secret.

No agent may access another agent's locator. The local emergency provider has
no remote shared key.

## Media and URLs

- MIME sniff uploads, enforce byte/duration/resolution limits, virus scan, and
  store outside the web root with random object names.
- Invoke FFmpeg through argument arrays, resource limits, and sandboxed workers.
- Verify actual output using FFprobe and SHA-256; never fabricate metadata.
- Affiliate/import URLs must use HTTPS, pass a domain allowlist, resolve outside
  private/link-local/loopback ranges, cap redirects, and pass phishing/malware
  screening.

## Publishing

Default mode is draft/private. Approval binds owner, artifact hash, caption,
affiliate disclosures, destination, schedule, and expiry. Any mutation after
approval invalidates it. Only a platform response can create a publish receipt.
