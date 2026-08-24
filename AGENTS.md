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
16. **Account and Connection Isolation**: Every agent possesses unconfigured connection slots for email and social accounts (YouTube, Instagram, Facebook, Snapchat). No cross-agent token sharing is permitted. Real email addresses, active OAuth connections, and live social accounts are not connected or configured yet; live OAuth and social publishing remain pending.
17. **Opaque Secrets & Safe Serialization**: Real API keys, tokens, or passwords must never be stored in plain text or in the database (use secret-manager URLs like `vault://...`). Dashboard serializations use an explicit safe-output allowlist (DTO) and block unknown fields.

---

# Part 2 — AI Agent Operations Kit (addendum to the contract)

Rules 1–17 above remain the law. This part adds operational instructions for
autonomous AI agents (Jules, night-shift agent) and human helpers.

## Environment
- Node.js >= 20 · PostgreSQL 15+ (schema only; tests run without a DB)
- ZERO-RUNTIME-DEPENDENCY POLICY: never add npm packages. Use node:test,
  node:crypto, node:http. If a dependency seems required, STOP and document
  why in the PR.

## Commands (must pass before every PR)
- npm test
- npm run verify

## Hard Rules (PR auto-blocked if violated)
- R1: New SQL = new file sql/NNN_name.sql. NEVER edit existing migrations.
- R2: All outbound serialization goes through existing safe-DTO helpers (Rule 17).
- R3: HTTPS-only URL parsing; YouTube allowlist logic preserved.
- R4: Rule 15 (agent names internal-only) applies to every file touched.
- R5: Status enums stay exactly as defined — no new states without an issue.
- R6: Every PR body includes `Closes #<issue>` + real pasted test output.
- R7: Behavior change => update docs/ in the same PR.
- R8: Branches named `task/<issue#>-<slug>`; conventional commits.
- R9: CI failure => fix in the same PR, max 3 attempts, then label the issue
  `blocked` and comment exactly where you're stuck.

## Territory Map
| Agent | May write | Everything else |
|---|---|---|
| Jules | src/broker/**, src/providers/**, credential sql/* | read-only |
| Night-shift agent | src/api/**, src/repos/** | read-only |

## Single-Lane Mode
Only ONE open PR at a time across the repo. Never start a new issue while any PR is open.

## Definition of Done
- [ ] npm test && npm run verify pass
- [ ] New behavior has new tests
- [ ] Docs updated + PR evidence posted

## Amendment — post-merge reality (supersedes Part 2 where they conflict)
1. The zero-dependency rule is retired: the repo now ships express, pg, argon2,
   and supertest. Prefer built-ins; add a dependency only when the task truly
   requires it, and justify it in the PR body.
2. PR bodies MUST contain `Closes #<issue>` so issues auto-close on merge.
3. ONE PR in flight at a time. Never open a second while one is open.
