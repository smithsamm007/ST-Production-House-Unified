# ST Production House — Master Blueprint

**Version:** 2.1 · **Status:** CANONICAL · **Established:** 2026-11-27
**Owner:** the single Owner of ST Production House
**Supersedes:** Master Blueprint v1 (2026-09), retained in Git history

> This document is the single canonical product, business, architecture and
> operational blueprint for ST Production House. Every future engineering,
> production, automation and commercial decision is measured against it.
> It is a specification, never a claim that a capability exists. Current
> implementation status is recorded separately in
> [§16](#16-implementation-status-2026-11-27).

---

## 0. Document control

### 0.1 What this document is

| Property | Value |
|---|---|
| Scope | Product vision, business model, executive organisation, authority, Director architecture, production lifecycle, cloud architecture, distribution, revenue, security, evidence, recovery, roadmap |
| Audience | Owner, ECC, HERMES, Directors, coding agents, human contributors |
| Authority | Canonical for product and business intent; subordinate to `AGENTS.md` on safety |
| Change control | Owner-only amendment, documented in §18 |

### 0.2 Precedence

When two sources disagree, the higher row wins:

| Rank | Source | Governs |
|---|---|---|
| 1 | `AGENTS.md` Rules 1–17 and R1–R9 | Safety, evidence, secrets, migrations, PR law |
| 2 | **This blueprint** | Product definition, organisation, authority, business model, phases |
| 3 | Domain contracts — `docs/SECURITY.md`, `docs/MERGE_PATH_CONTRACT.md`, `docs/TERRITORY_GUARD.md`, `docs/PUBLISHING_APPROVALS.md`, `docs/media/*`, `docs/publishing/*` | The mechanics of their own domain |
| 4 | `ROADMAP.md` | Engineering task execution order |
| 5 | Everything else | Supporting detail |

A domain contract may make a rule **stricter** than this blueprint; it may never
make it looser. Where an external engineering framework or industry default
conflicts with rows 1–3, the repository's own contract wins.

### 0.3 Status vocabulary

Every claim in this repository uses exactly these labels:

| Label | Means |
|---|---|
| **VERIFIED** | Executed and observed, with recorded output, receipt or artifact hash |
| **IMPLEMENTED (OFFLINE)** | Real code plus passing tests; no live provider, account or platform call |
| **CONTRACT-ONLY** | Adapter or contract exists; depends on owner-gated credentials or platform access |
| **DOCUMENTED ONLY** | Specified in prose; no enforcing code |
| **NOT BUILT** | No code, no schema, no contract |

"The blueprint describes it" is never evidence that "the repository implements it".

---

## 1. Product vision and mission

### 1.1 Definition

> **ST Production House is an Owner-controlled, cloud-native, autonomous AI
> animation and media company that operates multiple independent creative
> universes across multiple niches, languages and distribution platforms.**
>
> It continuously researches opportunities, develops original intellectual
> property, creates animated content, distributes it, grows audiences and manages
> commercial opportunities through platform monetisation, affiliate marketing,
> sponsorships, brand collaborations, brand promotions, licensing and other
> approved revenue models.
>
> It operates continuously without depending on the Owner's computer or daily
> presence, subject to explicit financial, security, legal, platform and
> publishing policies.

### 1.2 Mission

Build a media company that produces original animated content at industrial
reliability, in several languages, under several independent brands, across
several platforms — while remaining fully owner-governed and evidence-disciplined.

### 1.3 What ST is not

- Not a multi-channel YouTube automation tool. YouTube is one destination of five
  wired adapters and one of many possible platforms.
- Not a video generator. Generation is one stage of a nineteen-step lifecycle.
- Not an autonomous agent with unlimited authority. Every irreversible act is
  owner-reserved or policy-delegated.
- Not "24/7 operational" until an unattended cloud run has been observed and
  recorded. No document, schema, mock or placeholder makes that true.

### 1.4 Six design clauses

| # | Clause | Testable requirement |
|---|---|---|
| D1 | Owner-controlled | Every irreversible, financial, security or publishing action resolves to the Owner or to a versioned policy the Owner activated |
| D2 | Cloud-native | No production work executes inside the Owner's browser or local terminal |
| D3 | Autonomous | Work continues, resumes and recovers while the Owner is offline |
| D4 | Multiple independent universes | Directors share no pipeline, accounts, memory or publishing identity |
| D5 | Real media business | Output is original animated content, distributed on real platforms, with revenue measured from real records |
| D6 | Bounded authority | No AI executive can rewrite its own authority, exceed financial limits, or make irreversible decisions |

---

## 2. Business model

### 2.1 What the company produces

Animated long-form video, episodic series, documentaries, educational content,
entertainment formats, short-form media, promotional reels and platform-specific
versions — each attached to a Director's owned creative universe and brand.

### 2.2 How the company earns

Five engines, described fully in §11: platform monetisation, affiliate marketing,
brand collaborations, brand promotions and sponsorships, and intellectual
property licensing (with merchandise, digital products and other approved
opportunities as extensions).

### 2.3 Cost structure and financial discipline

| Constraint | Rule |
|---|---|
| Free capacity first | Approved free providers are used before any paid path |
| No paid overage | A quota ceiling produces an honest wait, never a silent charge |
| No unapproved spend | Subscriptions, paid tiers and financial commitments are Owner-reserved |
| Cost visibility | Provider cost and operating cost are recorded per production and reported |
| No revenue guarantees | Projected, modelled or view-derived income is never shown as revenue |

### 2.4 Unit of work and of business

- **Production unit:** one release (one episode, short or campaign asset) with an
  artifact hash, QC verdict and evidence chain.
- **Business unit:** one Director's universe — the smallest entity that carries its
  own brand, accounts, audience, commercial strategy and P&L.
- The company is the sum of its universes; the Owner is the only entity above them.

---

## 3. Executive organisation

```
OWNER
 ├── ECC — Chief Engineering Executive
 │     accountable to the Owner for engineering
 └── HERMES — AI Managing Director
       accountable to the Owner for business and creative operations
       └── Independent AI Directors (one creative universe each)
```

ECC and HERMES are **peers**, not a hierarchy. Neither reports to the other.
Disagreement escalates to the Owner.

### 3.1 Owner

Ultimate authority. Reserved decisions (§4.3) are never delegated by silence,
convenience, or an agent's judgement.

### 3.2 ECC — Chief Engineering Executive

| Responsibility | Detail |
|---|---|
| Engineering strategy and architecture | Technical direction, standards, technology selection |
| Codebase governance and technical planning | Work decomposition, standards, review policy |
| AI coding agents and engineering automation | Assignment, harness, workspace, model routing, concurrency |
| Software development, review, QA | Implementation, review gates, test strategy |
| Security engineering and infrastructure | Secrets, access control, dependency and licence posture |
| Cloud architecture, DevOps, CI/CD | Runtimes, deployment, pipelines, environments |
| Reliability, observability, recovery | Monitoring, watchdogs, incident response, restore |
| Engineering evidence and risk reporting | Delivery evidence, technical risk, status to Owner |

**ECC must not become the creative Managing Director.** ECC holds no creative,
audience, commercial or publishing authority, and cannot widen its own authority.

### 3.3 HERMES — AI Managing Director

| Responsibility | Detail |
|---|---|
| Company-wide operational coordination | What happens next, where, in what order |
| Creative strategy and production planning | Slate, formats, cadence |
| Director management and resource allocation | Assignment, capacity, priorities |
| Production scheduling and prioritisation | Per-Director schedules within declared limits |
| Quality and delivery coordination | QC acceptance, rework decisions |
| Audience and business performance | Performance review, learning |
| Commercial opportunity coordination | Campaigns, partnerships, sponsorships |
| Delegated operational decisions | Only inside an active, versioned Owner policy |
| Exception management and Owner reporting | Escalation, blocked work, incidents |

**HERMES must not override engineering security controls, hold credentials, or
change its own authority.** HERMES coordinates Directors; it must never turn
independent Directors into departments or workers in one shared pipeline.

### 3.4 Independent AI Directors

Each Director owns one creative universe: its niche, sub-niches, genres, themes,
languages, audience, creative identity, brand, characters, IP, story worlds,
continuity, production teams, workflows, publishing configuration, commercial
strategy and performance/financial records. See §5.

### 3.5 Communication contracts between the two domains

| From → To | Contract |
|---|---|
| HERMES → ECC | **Requirement** (need, constraints, acceptance evidence). HERMES cannot dictate architecture |
| ECC → HERMES | **Capability** (delivered, verified, limits, cost, failure behaviour). ECC cannot dictate creative direction |
| Director → HERMES | Production decision request within the Director's charter |
| HERMES/Director → Owner | Escalation with options, risks, recommendation and deadline |
| Any → Owner | Reserved decision (§4.3), always explicit |

Rules: creative agents never receive engineering secrets or infrastructure
administration; engineering agents never receive publishing approvals or
platform credentials; on-call of the two domains is separated.

### 3.6 Naming reconciliation (open decision OD-1)

The canonical executive name is **ECC**. The existing control plane implements the
same seat under the internal name **FORGE** (`src/forge/**`, role string
"Chief Engineering Executive"). Until the rename decision is resolved by the Owner,
both names refer to one office, and no second authority may be created. This
reconciliation is recorded rather than silently "fixed", because renaming code is
an engineering change, not a documentation change.

---

## 4. Authority and governance

### 4.1 Routine autonomous decisions (HERMES)

Scheduling within declared limits · task assignment · retries within approved
limits · creative revisions inside an approved charter · quality rejection and
rework · rescheduling · safe recovery of failed jobs.

### 4.2 Policy-limited delegated decisions (HERMES)

Approved provider fallback · bounded resource reallocation · eligible publishing
or commercial operations — **only** inside an explicit, active, unexpired,
versioned Owner policy scoped to that decision class.

### 4.3 Owner-reserved decisions (never delegable)

| Reserved | Meaning |
|---|---|
| Company ownership and control | Who owns ST and its assets |
| Global policy and executive authority | Any change to §3 or §4 |
| Financial commitments beyond delegated limits | Spend, subscriptions, paid services |
| Security and account ownership | Credential transfers, account connections |
| Destruction of critical records or business data | Irreversible data loss |
| Changes to Owner approval requirements | Including this list |

Enforced category set (`src/forge/delegationEngine.js`):
`spend.above_limits`, `credentials.new_account_connection`,
`security.global_governance_change`, `data.destructive_deletion`,
`ownership.transfer`, `deploy.production`, `github.merge_outside_policy`.
Creating a delegation policy for any of these must fail closed.

### 4.4 Delayed Owner decisions

For any request requiring Owner attention:

1. Record the request, options, risks, recommendation and deadline durably.
2. Notify the Owner.
3. Start any response timer **only after notification delivery is confirmed**.
4. Honour the Owner's response — rejection is terminal for that request.
5. **Never interpret silence alone as approval.**
6. After timeout, act only if an active policy explicitly delegates that exact
   decision.
7. Otherwise pause, use a safe alternative, or escalate.

**The five-hour window for eligible publishing requests is confirmed in the
current approved specification** (`OWNER_APPROVAL_WINDOW_MS = 5 * 60 * 60 * 1000`,
`src/publishing/hermesPublishingTimeout.js`), with the durable deadline worker and
the delegated-decision record in `src/publishing/`).

### 4.5 The publishing gate (Rule 7)

Publishing requires all of:

- Valid Owner approval, or valid explicitly delegated authority under an active policy.
- Mandatory technical and creative QC verdicts.
- Copyright, licensing and rights checks.
- Privacy, safety and disclosure checks.
- Durable evidence.
- Binding to the exact artifact hash, destination, caption, affiliate links and disclosure.
- Revalidation of every binding immediately before execution.

A retry with a durable receipt must replay with zero network calls: a published
artifact can never be published twice.

### 4.6 Governance invariants

1. An AI executive cannot change its own permissions (§4.3).
2. Governance is enforced in code, not only in prose.
3. Every governed mutation leaves an audit event and evidence record.
4. Escalation is a success path; silent autonomous resolution of a reserved
   decision is a defect.

---

## 5. Director and universe architecture

### 5.1 Independence invariants (Director #50 exactly as Director #01)

1. One Director = one creative universe = one public brand identity.
2. Each Director has its own unconfigured email and social connection slots. No
   token, session or account is ever shared between Directors (Rule 16).
3. Each Director has its own memory, workspace, schedule, queues and production
   history; every read is scoped by Owner **and** Director.
4. Retirement is in place: history is never reassigned to another Director.
5. Internal Director names are internal-only and never appear in public output (Rule 15).
6. No Director is silently converted into a department of a house-wide pipeline.

### 5.2 Director configuration schema

A Director's configuration must include: niche · sub-niche · genres · themes ·
language and localisation · target audience · content formats · visual style ·
narrative style · brand identity · publishing destinations · commercial
opportunities.

The **publishing destinations** element is specified in full by the per-Director
distribution profile in [§10.4](#104-per-director-multi-platform-distribution-profiles):
one profile per Director per platform, versioned with the charter.

### 5.3 Capacity and expansion

- Architecture supports up to **50 active Directors**, enforced at application and
  database level (cap lock + trigger). The cap is a limit, not a claim that 50
  Directors operate.
- Directors are activated deliberately, never by running a migration.
- Retirement and suspension block new work without deleting history.

### 5.4 Current portfolio (example direction, not operational claim)

| Director | Universe / niche |
|---|---|
| JARVIS | Hindi/Hinglish horror, thriller, suspense |
| SHERLOCK | Crime and mystery |
| LAKME | Indian mythology and folklore |
| NEWTON | Indian current affairs and opportunities |
| COSMOS | Space, science, aliens, discoveries |
| CHRONOS | History and historical animation |
| AI NEWS | AI and technology |
| BUTTERFLY | Romance and emotional storytelling |
| AADI | Global discoveries and research |
| TECH MASTER | Technology education |

### 5.5 Formats

Animated films · episodic series · documentaries · educational content ·
entertainment · short-form media · promotional reels · platform-specific versions.

The **main video + 2 content Reels + 1 brand Reel** package remains a supported
default format. It is not the only permitted format; a Director may choose other
formats its niche requires.

---

## 6. Multi-language and multi-niche strategy

### 6.1 Language as a first-class property

Language is declared at Director level, refined at series level, and realised as a
**produced artifact** — not a caption applied afterwards.

| Layer | Requirement |
|---|---|
| Script | Language-specific script and adaptation, not literal translation |
| Voice | Voice identity and pronunciation profile per language |
| Subtitles | Subtitle plan per language, validated against the rendered audio |
| Metadata | Title, description and tags localised per destination and region |
| Packaging | Thumbnail text and brand assets localised |
| QA | Language-specific QC: pronunciation, reading speed, subtitle timing |

Every localised version is its own artifact version with its own hash and
evidence; it never overwrites the source version.

### 6.2 Niche taxonomy

Two levels: Director (universe) → sub-niche. Every sub-niche inherits the
Director's public identity, charter and account isolation. A new sub-niche is a
configuration change, never a new shared pipeline.

### 6.3 Rights and originality

Original IP is the default. Bundled third-party music, fonts, stock media or model
weights are prohibited until commercial rights are documented (Rule 12). Research
sources are recorded with date and URL; audience claims require a source record.

---

## 7. Production lifecycle

Nineteen steps, grouped into eight governed stages. Each stage has an output and an
**evidence requirement**; a stage that cannot produce its evidence must stop
honestly.

| Stage | Steps | Output | Required evidence |
|---|---|---|---|
| **1 Research** | 1–2 Market/trend/audience research · opportunity and content-gap discovery | Opportunity brief | Dated source records with URLs and retrieval time; no invented demand figures |
| **2 Development** | 3–6 Concept · story/script · characters and world · storyboard and scene plan | Script, bible, board | Script version history + charter compliance + continuity check against Director memory |
| **3 Generation** | 7–9 Visuals and animation · voice and localisation · music and sound | Assets | Real rendered bytes per asset; provider execution record or local render log; asset hashes |
| **4 Assembly** | 10–12 Video assembly/editing · subtitles and localisation · thumbnail and metadata | Episode, reels, packages | FFprobe-measured duration/streams; VERIFIED descriptor; artifact SHA-256; package manifest bound to hash |
| **5 QA** | 13–14 Technical and creative QA · copyright, licensing, disclosure | QC verdict | Visual consistency, loudness, duration window, rights check, technical spec — each recorded; failures fail closed |
| **6 Approval** | 15–16 Final package and evidence · publishing eligibility and approval | Approval record | Rule 7 binding (artifact hash, destination, caption, links, disclosure) + QC verdicts + rights clearance |
| **7 Distribution** | 17 Scheduling and distribution | Receipt | Real platform response only; submission ≠ publication |
| **8 Learning** | 18–19 Audience analytics and evaluation · creative and operational improvement | Performance and revenue records | Server-sourced platform records; no estimated views or revenue |

### 7.1 Lifecycle laws

1. **No stage fabricates a downstream artifact.** A missing dependency produces a
   truthful wait or a labelled `placeholder`, never a passing artifact.
2. **Idempotent by hash.** Identical input reproduces identical output and stores it
   once; different output becomes a new version, never a duplicate logical entity.
3. **One logical Reel per product/service identity** (Rule 8); a failed attempt adds
   a version. Main-video promotion is a separate Owner decision (Rule 9).
4. **Promotion is a business record, not a new video** (see §11.2).
5. **Language versions are sibling artifacts**, each with its own evidence.

---

## 8. Cloud architecture

### 8.1 Separation of planes

```
Owner dashboard (browser, phone, Chromebook)
        │  HTTPS + session + CSRF
        ▼
Control plane  ── policy · identity · approvals · evidence · quotas · audit
        │
        ├── durable job queue (leases, idempotency keys, DLQ)
        ├── scheduler (cron/interval work, independent of any process lifetime)
        ├── secrets broker (opaque locators only)
        └── PostgreSQL (policy, state, evidence, analytics)
        │
        ▼
Production workers (isolated, restartable, claim → execute → checkpoint)
        │
        ├── provider adapters (approved free tiers first)
        ├── media executors (TTS, visual, motion, FFmpeg, FFprobe)
        └── cloud object storage (scripts, assets, renders, packages)
```

The control plane owns policy, identity, approvals, evidence, quotas and audit.
Workers never write the database directly; they report results and artifacts.

### 8.2 Component requirements

| Component | Requirement |
|---|---|
| Backend | Persistent, reachable over HTTPS, no dependence on the Owner's device |
| Database | Managed PostgreSQL 15+, backups, restore drill executed |
| Queue | Durable leases, idempotency keys, retry limits, dead-letter handling, concurrency controls (Rule 13) |
| Scheduler | Independent service; fires with no browser open and no owner device |
| Workers | Restartable; a killed worker never destroys a job; reclaim after lease expiry |
| Object storage | All scripts, assets, renders and packages; no local-disk dependency |
| Secrets | External manager; only opaque locators in the database (Rules 4, 5, 17) |
| Monitoring | Health, readiness, stalled-queue and stalled-worker alerts |
| Cost control | Quota windows, per-provider limits, hard caps, honest wait on exhaustion |
| Audit | Append-only, hash-chained evidence ledger plus audit events |
| Dashboard | Owner remote access to approvals, evidence, health, spend, revenue |

### 8.3 Free-tier honesty

Every always-on component must state: measured consumption, the free-tier ceiling,
and the behaviour at that ceiling (wait, degrade honestly, or stop). A silent paid
overage is a policy violation, not a scaling strategy. GitHub Actions and Codespaces
are engineering automation surfaces; they are **not** the production control plane.

---

## 9. 24/7 operation

| # | Requirement | Acceptance evidence |
|---|---|---|
| C1 | Control plane reachable from any browser | Authenticated dashboard served from cloud infrastructure |
| C2 | Managed database with tested backups | Restore drill executed and recorded |
| C3 | Durable queue and independent scheduler | Work fires and survives restarts with no browser open |
| C4 | Independent workers | Kill/restart drill: no job lost, no double execution |
| C5 | Cloud object storage | Workers and dashboard read media without a local disk |
| C6 | Monitoring and watchdogs | Alert on stalled queue/worker; automatic bounded recovery |
| C7 | Secrets management | Locator-only references; rotation drill |
| C8 | Quota and cost guards | Hard caps; measured use; verified wait/resume |
| C9 | Audit and evidence durability | Ledger survives restart and deployment |
| C10 | Remote Owner dashboard | Approvals, evidence, health, spend, revenue off-device |
| C11 | Recovery | DLQ handling, circuit breakers, replay without duplication |
| C12 | 24-hour observation | A recorded unattended run including one recovered failure |

**A failed worker must never destroy a production job.** Jobs resume from durable
state and execute idempotently.

---

## 10. Multi-platform distribution

### 10.1 Platform matrix

| Platform | Formats | Capability tracking |
|---|---|---|
| YouTube + Shorts | Long-form, Shorts | OAuth lifecycle, resumable upload, private-first, receipts, analytics |
| Instagram + Reels | Reels, short-form | Graph API container → upload → publish, receipts, analytics |
| Facebook | Page video | Resumable upload, Page-scoped token, receipts, analytics |
| Snapchat | Spotlight | Encrypted media pipeline, allowlist access, receipts |
| Bilibili | Long-form archive | Chunked submission, signer, whitelist codes 127304/127305 |
| Additional | Per adapter | Added only with an official API and an approved adapter |

### 10.2 Per-platform record

Each integration independently tracks: API and account capability; authentication
and permissions; publishing requirements; media specifications; rate limits and
quotas; monetisation eligibility; publishing receipts; analytics availability;
errors and recovery.

### 10.3 Distribution honesty laws

1. **No claim without evidence.** API access, account approval, monetisation
   eligibility and successful publishing are recorded only from real responses.
2. **Automation does not grant monetisation.** Platform rules, account standing,
   region and originality review decide eligibility.
3. **Per-Director accounts**, no shared identity, no account rotation to evade limits.
4. **Official APIs only** — no unofficial browser automation, no borrowed credentials.
5. **Private-first by default** where the platform allows it.
6. **Submission ≠ publication.** A review-pending receipt is recorded as exactly that.
7. **Destination routing fails closed.** An unwired destination never falls through
   to another platform's adapter.

---

### 10.4 Per-Director multi-platform distribution profiles

Every Director owns an **independent distribution profile** covering all five
wired platforms — YouTube and YouTube Shorts, Instagram and Reels, Facebook,
Snapchat, Bilibili — plus any additional platform added through an approved
extensible adapter. A profile belongs to the Director's charter (§5.2), not to a
house-wide setting, and no Director shares an account, token or publishing
identity with another.

#### 10.4.1 Profile record (one per Director, per platform)

| Field | Meaning | Rule |
|---|---|---|
| `platform` | `youtube` · `instagram` · `facebook` · `snapchat` · `bilibili`, plus approved adapters | Must be a supported destination; unknown platforms fail closed |
| `accountRef` | Channel / page / profile identifier as returned by the official identity API | Never invented; sensitive values stay opaque in DTOs |
| `accountOwner` | Who legally controls the account (Owner or an approved delegate) | Changing it is Owner-reserved (§4.3) |
| `language`, `region` | Declared language and target region for this destination | Inherited from the Director charter (§6) |
| `allowedFormats` | Long-form, Shorts/Reels, Spotlight, archive, promotional | Must be a format the Director's charter permits |
| `destination` | The routing key the destination router resolves | Must resolve to that platform's own adapter, never another's |
| `disclosureDefaults` | Default disclosure template and placement for paid/affiliate content | Non-empty whenever campaign content is allowed (§11.2) |
| `status` | One of the six lifecycle states in §10.4.2 | Starts at `not_configured` or `access_unverified`; never `live_enabled` without evidence |

#### 10.4.2 Status lifecycle

`not_configured → access_unverified → credentials_pending → approved_private_only
→ live_enabled`, with `suspended` reachable from any state.

| State | Meaning |
|---|---|
| `not_configured` | No account reference recorded for this Director and platform |
| `access_unverified` | Account reference recorded; capability and permissions not proven |
| `credentials_pending` | OAuth started, or platform review/approval outstanding |
| `approved_private_only` | Authorized, but publishing is limited to private/unlisted |
| `live_enabled` | A real platform receipt exists for this Director and platform |
| `suspended` | Blocked by platform, quota, policy or Owner action |

Rules: no transition to `live_enabled` without a stored real receipt; `suspended`
is always reachable and must state why; every transition writes an audit event.
Every new Director and every new platform starts at `not_configured` or
`access_unverified`.

**Reconciliation with existing enums (R5).** The repository already defines OAuth
account status `unconfigured | connected | expired | disconnected` (`sql/003`) and
connection status `not_configured | configured | unverified | connection_failed`
(`sql/022`). Those enums stay authoritative for their own records and are **not**
changed by this section. The six-state lifecycle above is a new, additive concept:
introducing it requires an issue and a new migration (§15.3, F1), never an edit of
an existing enum.

#### 10.4.3 Credentials and token lifecycle

- **One credential set per Director per platform**, stored only in the external
  secret manager; PostgreSQL keeps an opaque locator (Rules 4, 5, 17).
- **Isolation.** Resolution is scoped by owner **and** Director. Another Director,
  HERMES, any creative agent, or any Director's agents must be unable to read the
  token; a cross-Director read is indistinguishable from a missing credential.
- **Refresh.** Performed server-side through the platform's official refresh flow
  before expiry. A refresh failure moves the profile to `credentials_pending`,
  emits an audit event, and never falls back to another Director's credential.
- **Expiry.** An expired token blocks publishing for that Director and platform
  only, and the profile reports the honest state.
- **Revocation.** Owner-initiated revocation calls the platform's official
  revocation endpoint, destroys the stored secret and its locator, and moves the
  profile to `not_configured`.
- **No leakage.** No token, refresh token, locator, client secret or authorization
  code ever appears in a DTO, log, audit payload, error message or artifact.

#### 10.4.4 Capability record

Per Director and per platform, the profile tracks: API and account capability;
permissions granted; media specifications (codec, aspect ratio, duration, size
limits); rate limits and quota consumed; monetisation eligibility; publishing
receipts; analytics availability; errors and recovery path. Every field records an
observed fact; unknown values remain explicitly unknown rather than assumed.

#### 10.4.5 Isolation and shared platform-level quotas

- A failure, suspension, credential expiry or quota exhaustion on one Director's
  account **must not block another Director**. Job and quota scopes are per
  Director: the blocked profile enters an honest wait while others continue.
- Some quotas are **shared platform-level resources, not per-account**: the YouTube
  Data API quota belongs to the Google Cloud project, not to a channel. Such
  resources are modelled explicitly as shared, with fair allocation across
  Directors (reserved headroom, a per-Director fair-share ceiling, wait-and-resume
  on exhaustion) and centrally recorded consumption.
- **Multiplying projects or accounts to evade a platform quota is prohibited.**
  The compliant path is a quota-extension request through the platform's own
  audit/review process, recorded with its outcome.

#### 10.4.6 Platform requirements recorded as unverified

Until a real receipt proves otherwise, these stay marked unverified:

| Platform | Requirement |
|---|---|
| YouTube | API compliance audit — uploads remain private until the project is audited |
| Meta | Business account plus app review for Instagram/Facebook publishing permissions |
| Snapchat | Creator/Public Profile API access limits and allowlisting |
| Bilibili | Upload (投稿) access, monetisation access and regional restrictions |

#### 10.4.7 Publishing gate (unchanged)

Publishing from any profile still requires: Owner approval or valid explicit
delegated authority; technical and creative QC; copyright, licensing, privacy,
safety and disclosure checks; artifact hash and destination binding; and
revalidation immediately before execution (§4.5). A `live_enabled` profile never
substitutes for the gate, and submission still never equals publication.

#### 10.4.8 Charter linkage and versioning

The distribution profile is part of the Director's charter: versioned,
owner-approved, amended only through §18.3. Changing an account reference,
destination, disclosure default or status is a charter amendment with an audit
event. A revoked or suspended profile cannot be silently re-enabled.

#### 10.4.9 Current status and sequencing

**Implemented today** (§16): a per-Director OAuth connection engine with
per-platform providers, owner-and-Director scoping, hashed single-use state, PKCE,
secret-manager custody and revocation; five supported destinations with
fail-closed routing; five-platform database constraints (`sql/047`); a per-Director
quota ledger.
**Contract-only:** real platform access and real receipts.
**Not built:** the six-state profile record; per-Director language/region/format/
disclosure fields; shared platform-level quota accounting; the capability record;
compliance-audit tracking.

**Now:** JARVIS on YouTube first. **Next:** the remaining platforms for JARVIS,
then a second Director's profile. **Later:** further Directors and adapters — each
only after explicit Owner approval.

---

## 11. Revenue systems

### 11.1 Revenue streams

| Stream | Operations required | Evidence that counts |
|---|---|---|
| **A. Platform monetisation** | Eligible accounts, real audience, programme acceptance | Platform revenue report or payout API record |
| **B. Affiliate marketing** | Product/offer discovery, programme research, relevance and quality checks, approved link management, campaign creation, click/conversion tracking, disclosure compliance | Affiliate network commission record tied to a specific artifact |
| **C. Brand collaborations** | Brand discovery, prospect qualification, outreach, media kits and proposals, campaign planning, negotiation support, contract and deliverable tracking, performance reporting | Confirmed campaign record + delivered-asset evidence |
| **D. Brand promotions and sponsorships** | Sponsored episodes, product integrations, dedicated promotional animations, brand reels, campaign packages, sponsor reporting | Campaign confirmation + disclosure evidence + delivered asset |
| **E. IP and other revenue** | Character/franchise licensing, story and animation licensing, merchandise, digital products | Executed licence record + licensed asset manifest |

### 11.2 Campaign rules

- A campaign is a business record. It never creates a second logical video.
- One standalone Reel per product/service identity (Rule 8).
- Affiliate links: HTTPS only, allowlisted domain, no embedded credentials, standard
  port, no private hosts, disclosure bound verbatim, redirect/SSRF inspection.
- Main-video promotion is an explicit Owner decision at intake (Rule 9), never implied.

### 11.3 Financial reporting model

Every figure is classified; they are never mixed:

| Class | Meaning |
|---|---|
| Estimated revenue | Modelled or projected — **never** displayed as actual |
| Contracted revenue | Signed/confirmed, not yet delivered |
| Earned revenue | Delivered and invoiced |
| Verified platform revenue | Platform-reported, reconciled |
| Affiliate commissions | Network-reported, tied to an artifact |
| Received payments | Settled in an account, with date and reference |
| Operating costs | Infrastructure, tools, subscriptions |
| Provider costs | Per-production provider consumption |
| Profit and loss | Derived only from the classes above |

### 11.4 Revenue laws

1. Revenue is **recorded, never estimated**.
2. Every amount traces to a source record with date, currency and reference.
3. No revenue guarantees, no projected income presented as income.
4. Disclosure is mandatory for every paid or affiliate placement.
5. Rights precede licensing (Rule 12).

---

## 12. Security and compliance

| Area | Rule |
|---|---|
| Secrets | External secret manager only; opaque locators in the database (Rules 4, 5, 17) |
| Credential isolation | Per-owner, per-Director, per-task-slot; no borrowing, no rotation abuse |
| Operator access | Authenticated session + CSRF for browser mutations + authorization + audit (Rule 6) |
| Serialization | Explicit safe-output DTO allowlist; unknown fields blocked (Rule 17, R2) |
| Public output | Internal agent names never appear (Rule 15, R4) |
| Network | HTTPS only; host allowlists; no private hosts; SSRF defence (R3) |
| Licensing | No third-party media/model weights without documented commercial rights (Rule 12) |
| Third-party software | Integrated behind adapters, never vendored (Rule 10); Postiz remains a separately deployed AGPL service (Rule 11) |
| Platform terms | Official APIs and documented permissions only |
| Privacy | No personal data in logs, evidence exports or public artifacts |
| Data protection | Backups, restore drills, no destructive deletion without Owner authority |

Security changes, credential transfers and account ownership are Owner-reserved
(§4.2), and security authority cannot be reassigned by an AI executive.

---

## 13. Evidence and observability

### 13.1 Evidence classes

Research source records · script and version history · asset provenance · provider
execution records · render manifests · FFprobe output · QC results · approval
records · publishing receipts · platform analytics · affiliate click/conversion
records · brand campaign contracts and deliverables · financial reconciliation
records · audit events.

### 13.2 Rules

1. **Rule 1.** Never claim a provider call, render, upload, post, test or
   verification occurred without durable evidence.
2. **Rule 3.** A degraded or unavailable dependency fails honestly; a placeholder is
   labelled and never passes production verification.
3. **Rule 2.** Never fabricate media, receipts, platform IDs, URLs, engagement counts,
   audit records or FFprobe output.
4. Evidence is append-only and hash-chained; an approval is bound to the exact
   artifact hash it approved.
5. Absence of evidence is reported as absence — never inferred as success.

### 13.3 Non-claims ST must never make

- "24/7 operational" without a recorded unattended run.
- "Fully autonomous" while any routine path needs the Owner's device.
- "Monetised" because an account is connected.
- "Published" when the receipt says review-pending.
- "Revenue" from estimated views.
- "Live provider generation" because executors and adapters exist.
- "50 Directors operating" because the cap is 50.
- "ECC/HERMES operating" because their roles exist in schema.

---

## 14. Recovery and autonomous operations

| Mechanism | Requirement |
|---|---|
| Leases | Time-bounded, reclaimable; expired leases recovered automatically |
| Idempotency | Every job keyed; a replay cannot duplicate work or output |
| Retry | Bounded attempts with backoff; terminal failure dead-letters |
| Dead letter | Inspectable, replayable after correction, never silently dropped |
| Circuit breaker | Opens on provider failure; no hammering; honest state surfaced |
| Quota waits | `WAITING_FOR_QUOTA` is a legitimate durable state with scheduled resume |
| Watchdog | Detects stalled queue/worker and acts within a bounded interval |
| Backup/restore | Executed drill with recorded result before any 24/7 claim |
| Incident | Detected → contained → evidenced → reported to Owner |

Recovery is part of the definition of done for every always-on component. A system
that cannot recover is not autonomous; it is unattended.

---

## 15. Roadmap and acceptance criteria

Ten independently verifiable phases. A phase is complete only with its own evidence.

| # | Phase | Depends on | Acceptance evidence | Owner gate |
|---|---|---|---|---|
| 1 | Canonical blueprint and governance | — | This document canonical; links consistent; docs checks pass | Ratification of v2 |
| 2 | ECC and HERMES executive architecture | 1 | Authority rules, audit trail and delegation tests; documented executive separation | Naming decision OD-1 |
| 3 | Independent multi-niche Director architecture | 2 | Two Directors producing independently with isolated histories and configs | Activation of each Director |
| 4 | Production orchestration and animation factory | 3 | Real provider-generated artifact, FFprobe-measured, QC-verified, 30–50 min long-form burn-in | Provider capacity onboarding |
| 5 | Persistent cloud infrastructure and 24/7 operation | 4 | 24-hour unattended run with one recovered failure; remote dashboard | Deployment + spend approval |
| 6 | Multi-platform publishing integrations | 5 | Real private-first receipt from at least one platform per Director | OAuth + account connection + publishing approval |
| 7 | Commercial operations and revenue tracking | 6 | One verified commission/campaign record tied to an artifact; P&L from records | Commercial policy + spend limits |
| 8 | Autonomous decision and recovery system | 2, 5 | One recorded delegation refusal, one escalation, one timeout handled per §4.4 | Policy activation |
| 9 | Monitoring, financial controls, Owner dashboard | 5, 7 | Off-device dashboard with real health, spend and revenue; cost caps enforced | Financial limits |
| 10 | End-to-end validation and 24-hour observation | 1–9 | Full lifecycle unattended for 24 h with evidence pack | Final acceptance |

### 15.1 Phase detail template

Every phase records: scope · dependencies · existing implementation · missing work ·
risks · acceptance criteria · required evidence · Owner approval requirements.
A feature is not complete because a UI, schema, mock provider or placeholder exists.

### 15.2 Sequencing laws

1. Do not start cloud infrastructure (5) before real provider generation (4) exists;
   otherwise "always-on" runs placeholder production.
2. Do not claim revenue (7) before verified publishing (6); revenue needs a real
   artifact and a real destination.
3. Do not scale Directors beyond proven isolation (3).
4. Every phase re-verifies the previous phase's evidence; earlier claims expire when
   the system changes materially.

### 15.3 FUTURE engineering tasks arising from §10.4 (not authorised now)

These are recorded as future work only. **No schema or code change is made by the
blueprint revision that introduced §10.4.**

| ID | Future task | Notes |
|---|---|---|
| F1 | Additive migration for `director_distribution_profiles` with the six-state lifecycle and an explicit mapping to the existing enums | Requires an issue first (R5); never edit migrations 001–047 |
| F2 | Shared platform-level quota model (project-scoped resource, reserved headroom, per-Director fair share, wait-and-resume) | Extends the existing per-Director quota ledger |
| F3 | Capability record persistence and evidence ingestion | Feeds §10.4.4 |
| F4 | Token refresh/rotation worker and a revocation drill | Feeds §10.4.3 |
| F5 | Compliance-audit tracking (YouTube audit, Meta app review, Snapchat limits, Bilibili access) | Feeds §10.4.6 |
| F6 | Wire per-Director language/region/format/disclosure defaults into packaging and metadata planning | Feeds §6 and §7 |
| F7 | Per-profile analytics availability and collection status | Feeds §7 stage 8 |

---

## 16. Implementation status (2026-11-27)

> **Basis:** code-and-record inspection of the repository at this date. Runtime
> suites were **not** re-executed for this document (no dependency install, no
> database, no credentials in the reviewing workspace). Evidence cited is the
> recorded artifact, test file or prior run — not a fresh verification.

### 16.1 Verified or implemented (offline)

| Area | Status | Evidence |
|---|---|---|
| Director catalogue, 50-cap, identity and connection isolation | VERIFIED | `sql/001–003`, `sql/032` cap lock + trigger, isolation tests |
| Creative charters, universes, reference library | VERIFIED | `sql/004–006` |
| Owner authentication (Argon2id, sessions, TOTP, CSRF) | VERIFIED | `src/catalog/ownerAuthentication.js`, `sql/008–009` |
| Durable jobs, leases, retries, DLQ, checkpoints | VERIFIED | `sql/010/012/015/016`, `src/jobs/**`, `src/workers/**`, lease-contention record |
| Quotas, cooldowns, provider routing, circuit breakers | VERIFIED | `sql/013–014`, `src/quotas/**`, `src/providers/**`, `src/resilience/**` |
| Secrets broker, opaque locators, safe DTOs | VERIFIED | `src/broker/**`, `src/credentials/**`, Rule 17 tests |
| Evidence ledger (append-only, hash-chained) | VERIFIED | `src/evidence/evidenceLedger.js` |
| Director workspace, memory, roadmap, conversation | VERIFIED | `sql/021`, `docs/ARCHITECTURE.md` |
| Per-Director schedule and duration policy | VERIFIED | `sql/029`, `src/scheduling/directorSchedule.js` |
| Canonical Director registry (10, retirement in place) | VERIFIED (code), cutover gated | `sql/032`, `docs/directors/CANONICAL_DIRECTOR_REGISTRY.md` |
| Engineering executive seat, permissions, reserved categories, 5-hour window | VERIFIED | `src/forge/**`, `src/publishing/hermesPublishingTimeout.js` |
| Media executors (TTS, visual, motion, FFmpeg, FFprobe, QC) | IMPLEMENTED (OFFLINE) | `src/media/**`; real renders recorded: 1,890 s long-form + three 30 s shorts |
| Deterministic pipeline and content planning | IMPLEMENTED (OFFLINE) | `src/pipeline/**`, `src/jarvis/**`, `src/aiNews/**` |
| Publishing approval, receipts, four official adapters, destination routing | CONTRACT-ONLY | `src/publishing/*Publisher.js`, `sql/043`, `sql/047` |
| Campaign intake and affiliate link safety | IMPLEMENTED (OFFLINE) | `src/promotion/campaignIntake.js` |
| Analytics storage and ingestion boundary | IMPLEMENTED (OFFLINE) | `sql/027`, `src/analytics/**` |
| Autonomous engineering loop (backlog → lanes → exact-head merge) | IMPLEMENTED (OFFLINE) | `src/orchestration/**`, `.github/workflows/**` |

### 16.2 Documented only

Motion/visual provider capacity binding · official analytics collectors · Meta and
Snapchat OAuth onboarding · Postiz deployment · Agentube external engine ·
Director cutover procedures.

### 16.3 Not built

| Gap | Note |
|---|---|
| Market, trend and audience intelligence (§7 stage 1) | No code or schema |
| Multi-language production and localisation (§6) | No code |
| Cloud runtime: deployment, managed DB, object storage, separate scheduler/watchdog (§8–9) | No infrastructure manifest of any kind |
| Any live platform receipt (§10) | No account connected; no upload ever performed |
| Revenue domain (§11) | No revenue, commission, sponsorship or licensing schema exists |
| Real platform analytics collection (§7 stage 8) | No official collector |
| Community management | No code |

### 16.4 Known blockers

1. **CI is red on `main`**: `sql/047_five_platform_support.sql` exists on `main`
   while `tests/applicationBoot.integration.js` pins the migration list at `046`;
   a second failure is recorded in fleet orchestration. The exact-head merge gate
   cannot pass until both are repaired at their cause.
2. **No live provider capacity is bound to any Director**, so worker-driven real
   media records an honest durable wait.
3. **Revision drift**: `ROADMAP.md` still shows some delivered items unchecked, and
   the executive seat is invisible in the architecture documents until this revision.

**Conclusion of this section:** ST today is a governed production control plane with
a proven offline media chain and contract-complete publishing adapters. It is **not**
24/7 operational, not fully autonomous, not monetised, and not production-ready.

---

## 17. Glossary

| Term | Definition |
|---|---|
| **Blueprint** | This document; canonical product and business specification |
| **Owner** | Ultimate authority; holds all reserved decisions |
| **ECC** | Chief Engineering Executive; engineering authority only |
| **HERMES** | AI Managing Director; business and creative operations |
| **Director** | Independent owner of one creative universe and brand |
| **Universe** | A Director's world: niche, IP, characters, audience, style |
| **Charter** | Owner-approved creative contract for a Director (voice, tone, brand, language) |
| **Release** | One planned production slot (episode/asset) with a unique identity |
| **Artifact** | A produced file with a SHA-256 hash; the unit of evidence |
| **Descriptor** | Verified metadata record for a media artifact |
| **Main video** | The primary long-form production of a release |
| **Reel** | Short-form promotional asset; one logical Reel per product identity |
| **Campaign** | Business record for a promotion, affiliate or sponsorship engagement |
| **Evidence ledger** | Append-only, hash-chained record of governed events |
| **Receipt** | Platform-native response proving a submission or publication |
| **Lease** | Time-bounded claim on a job by one worker; reclaimable on expiry |
| **DLQ** | Dead-letter queue for terminal failures awaiting review |
| **Quota window** | Declared provider capacity with cooldowns and reset time |
| **`WAITING_FOR_QUOTA`** | Durable honest state: work waits, then resumes |
| **Rule 7** | Publishing requires unexpired Owner approval bound to artifact and destination |
| **Rule 8** | One logical Reel per product/service identity; failures create versions |
| **Rule 15** | Internal agent/Director names never appear in public output |
| **Rule 16** | Per-Director account isolation; no token sharing |
| **Rule 17** | Opaque secrets and safe-output serialization |
| **DTO** | Safe-output allowlist object; unknown fields blocked |
| **Locator** | Opaque reference to a secret held in an external manager |
| **Verified** | Executed and observed with durable evidence |
| **Distribution profile** | A Director's per-platform record: account, language/region, formats, destination, disclosure defaults, status (§10.4) |
| **Shared platform quota** | A quota owned by the platform project, not one account, allocated fairly across Directors (§10.4.5) |
| **`live_enabled`** | A profile state that requires a stored real platform receipt; never inferred (§10.4.2) |

---

## 18. Version and change history

| Version | Date | Change | Author |
|---|---|---|---|
| 1.0 | 2026-09 | Initial master vision mapped to repository state; delivered/in-progress/not-started status map; provider fallback chain; publishing and monetisation rules; standing prohibitions | Owner instruction |
| 2.1 | 2026-11-27 | Adds §10.4 per-Director multi-platform distribution profiles (profile record, six-state lifecycle with existing-enum reconciliation, credential and token lifecycle, capability record, isolation and shared platform quotas, unverified platform requirements, charter linkage, Now/Next/Later status) and §15.3 future tasks. No code or schema change | Owner instruction |
| 2.0 | 2026-11-27 | Established as canonical. Adds: company definition and mission; business model and financial discipline; ECC/HERMES executive organisation with explicit may/may-not and communication contracts; authority matrix with routine/delegated/reserved classes and the delayed-decision procedure; Director configuration schema and 50-capacity model; multi-language and multi-niche strategy; nineteen-step lifecycle with per-stage evidence; cloud plane separation and component requirements; free-tier honesty; twelve 24/7 requirements; platform capability matrix and honesty laws; five revenue streams and nine-class financial reporting; security and compliance table; evidence classes and non-claims; recovery mechanisms; ten-phase roadmap with acceptance evidence; glossary; status re-verified and expanded. Preserves v1's status discipline, fallback chain, Reel/promotion rules and standing prohibitions | Owner instruction |

### 18.1 Preserved from v1 (nothing silently dropped)

- Delivered / in-progress / not-started status discipline, now §0.3 and §16.
- Provider and fallback sequence: cache/deterministic → approved free primary →
  secondary → tertiary → local open-source emergency → honest `WAITING_FOR_QUOTA`
  → scheduled resume, now §8–§9.
- Publishing and monetisation rules (Rule 7 approval binding, private-first,
  real receipts only), now §4.5 and §10.
- One-Reel identity, main-video promotion independence, affiliate link allowlisting,
  now §7.1 and §11.2.
- Standing prohibitions (fake evidence, placeholder passing verification, plaintext
  secrets, cross-agent sharing, internal names in public output, paid overages,
  unofficial automation, editing applied migrations), now §12–§13.
- Operating model (Owner approvals; governed coding agents; CI as independent
  referee; future autopilot runtime that never bypasses owner gates), now §3–§4.
- Roadmap items for secret-manager onboarding, real media burn-in, owner controls,
  official publishing, analytics and cloud autonomy, now §15.

### 18.2 Open decisions

| ID | Decision | Owner |
|---|---|---|
| OD-1 | Rename the engineering seat from FORGE to ECC in code, or keep FORGE as an internal alias of ECC | Owner + ECC |
| OD-2 | Which cloud provider and managed database to adopt for phase 5, against measured free-tier ceilings | Owner + ECC |
| OD-3 | Whether to consolidate `docs/IMPLEMENTATION_ROADMAP.md` and `docs/CONTINUOUS_DEVELOPMENT_PIPELINE.md` into pointers to this blueprint | Owner |
| OD-4 | Revenue schema design and the first commercial stream to enable | Owner + HERMES |

### 18.3 Amendment procedure

1. Only the Owner may amend this blueprint, or delegate an amendment class in a
   versioned policy.
2. Every amendment is a documentation change recording: the clause changed, the
   reason, affected phases, and the evidence that the change is safe.
3. Amendments are additive or explicitly superseding; silent redefinition is
   prohibited.
4. A change that alters the operating model updates this document in the same PR
   that changes the behaviour (R7).

---

*End of canonical blueprint. Implementation status is §16; the governing safety law
remains `AGENTS.md`. Nothing in this document asserts that ST is operational,
autonomous, monetised or production-ready.*
