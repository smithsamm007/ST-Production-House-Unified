# ST Production House Engineering Contract

These rules apply to every human or AI contributor.

1. Never claim that a provider call, render, upload, post, test, or verification
   occurred without durable evidence from the responsible system.
2. Never create fake media files, provider receipts, platform IDs, URLs,
   engagement counts, audit records, or FFprobe results.
3. A degraded or unavailable dependency must fail honestly. A placeholder may
   exist only when labelled `placeholder` and must never pass production
   verification.
4. Provider secrets belong in an external secret manager. The database stores
   opaque secret locators, scoped to one agent and one task slot.
5. Each task policy contains three private remote-provider slots and one local
   open-source emergency slot. Agents may not borrow another agent's secrets.
6. All owner routes require a valid authenticated session, CSRF protection for
   browser mutations, authorization, and an audit event.
7. Live publishing requires an explicit, unexpired owner approval tied to the
   exact artifact hash, destination, caption, affiliate links, and disclosure.
8. Product/service identity and the one-standalone-Reel reservation are
   database-enforced. A failed attempt creates a new artifact version, not a
   second logical Reel.
9. Main-video promotion is independent of the standalone Reel and is disabled
   unless the owner explicitly enables it at campaign intake.
10. Third-party projects are integrated behind adapters. Do not paste entire
    repositories into this codebase. Preserve licenses and provenance.
11. Postiz remains a separately deployed AGPL service accessed through its API.
12. Bundled third-party music, fonts, stock media, and model weights are
    prohibited until their licenses and commercial-use rights are documented.
13. Production queues require durable leases, idempotency keys, retry limits,
    dead-letter handling, and concurrency controls.
14. A change is complete only when its tests and verification commands pass.
15. **Agent Name Internal-Only Rule**: Agent names (e.g. JARVIS, SHERLOCK, PANCHI, VEDA) are strictly internal identifiers. They must never automatically leak into public videos, captions, descriptions, or social posts.
16. **Account and Connection Isolation**: Every agent must have its own isolated email and social connections (YouTube, Instagram, Facebook, Snapchat). No cross-agent token sharing or connection hijacking is permitted.
17. **Opaque Secrets & Safe Serialization**: Real API keys, tokens, or passwords must never be stored in plain text or in the database (use secret-manager URLs like `vault://...`). Dashboard serializations must recursively purge all locator and secret strings.
