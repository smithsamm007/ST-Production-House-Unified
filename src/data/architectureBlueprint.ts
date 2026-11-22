import {
  CapabilityDomain,
  DelegationPolicyItem,
  ImplementationPhaseSpec,
  MemoryLayerSpec,
  PermissionLevelSpec,
} from "../types/models";

export const SUPREME_HIERARCHY = [
  {
    tier: "Tier 1 · Strategic & Executive Command (1)",
    name: "OWNER",
    subtitle: "Founder & Visionary · Top-level governance & capital allocation",
    detail:
      "Defines system guardrails (output cadence, quality thresholds), approves major engineering roadmaps for FORGE, and sets overarching production targets for HERMES. Silence or non-response is never consent.",
  },
  {
    tier: "Tier 1 · Strategic & Executive Command (2)",
    name: "FORGE",
    subtitle: "Engineering Executive · Builder of ST Production House",
    detail:
      "Chief systems architect and engineering lead responsible for building, maintaining, and scaling ST Production House: control plane, worker queues, PostgreSQL schemas, lease/lock systems, LLM/media integrations, CI/CD, and self-healing codebase loops. Deploys stable releases to HERMES.",
  },
  {
    tier: "Tier 1 · Strategic & Executive Command (3)",
    name: "HERMES",
    subtitle: "Production Executive · Floor & Fleet Manager",
    detail:
      "Operational orchestrator managing the live production floor across all 50 creative universes: job scheduling, worker queue distribution, rate limits, API budget pacing, global cadences, and QC failure escalation back to FORGE. Dispatches production slots and resource leases to the 50 Independent Directors.",
  },
  {
    tier: "Tier 2 · Creative Universe Ownership",
    name: "50 INDEPENDENT DIRECTORS",
    subtitle: "Autonomous Universe & Channel Owners (strictly isolated · Rule 15 internal IDs)",
    detail:
      "50 isolated creative entities—each owning a distinct narrative universe, brand identity, audience niche, lore, character consistency, credentials, and publishing channel without cross-contaminating the other 49 Directors. Supervises its own dedicated 8-stage Director-Owned Team pipeline.",
  },
  {
    tier: "Tier 3 · Director-Owned Teams",
    name: "8-STAGE EXECUTION PIPELINE",
    subtitle: "Story · Visual · Audio · Assembly · Reels · Packaging · QC · Complete",
    detail:
      "Every Independent Director commands an isolated, sequential 8-stage pipeline taking a concept from raw prompt to archived, QC-verified master package queued for Rule 7 approved publishing.",
  },
] as const;

export const EIGHT_STAGE_PIPELINE_SPEC = [
  {
    stage: 1,
    key: "story",
    unit: "Story (Story & Beats)",
    deliverables:
      "Generates narrative arcs, scripts, scene-by-scene breakdowns, dialogue, and visual/audio prompts tailored to the Director's universe.",
  },
  {
    stage: 2,
    key: "visual",
    unit: "Visual (Scene Visuals)",
    deliverables:
      "Generates consistent character frames, environments, and motion clips based on Stage 1 scene prompts while enforcing visual style locks.",
  },
  {
    stage: 3,
    key: "audio",
    unit: "Audio (Voice & Sound)",
    deliverables:
      "Synthesizes character voiceovers/narration, scores background music (BGM), and layers spatial sound effects (SFX) timed to scene beats.",
  },
  {
    stage: 4,
    key: "assembly",
    unit: "Assembly (FFmpeg Assembly)",
    deliverables:
      "Executes programmatic media stitching—syncing visual tracks, voiceovers, BGM, transitions, and dynamic subtitles into a unified master render.",
  },
  {
    stage: 5,
    key: "reels",
    unit: "Reels (Short-Form Reels)",
    deliverables:
      "Extracts high-retention hooks, crops/reframes aspect ratios (9:16), and renders vertical micro-content derivatives for cross-platform reach.",
  },
  {
    stage: 6,
    key: "packaging",
    unit: "Packaging (Packaging)",
    deliverables:
      "Generates high-CTR thumbnails, SEO-optimized titles, episodic descriptions, tags, and structured metadata payloads.",
  },
  {
    stage: 7,
    key: "qc",
    unit: "QC (QC Gate)",
    deliverables:
      "Automated verification checkpoint—validates video/audio stream integrity (catching blank screens, missing BGM, or corrupt frames) and checks metadata completeness before release.",
  },
  {
    stage: 8,
    key: "complete",
    unit: "Complete (Complete)",
    deliverables:
      "Marks the job state as finalized in the database, archives master assets, releases worker leases, and queues the package for publishing.",
  },
] as const;

export const FEEDBACK_TELEMETRY_LOOPS = [
  {
    title: "QC Gate Failure → Retry / Escalation",
    route: "Stage 7 (QC Gate) → Director Retry | HERMES (Quota/API) | FORGE (Code/FFmpeg)",
    detail:
      "If Stage 7 flags a rendering defect, the job is retried locally by the Director's pipeline or escalated to HERMES (if quota/API-related) or FORGE (if a structural FFmpeg/code bug).",
  },
  {
    title: "Complete → HERMES → OWNER",
    route: "Stage 8 (Complete) → 50 Directors → HERMES Fleet Roll-Up → OWNER",
    detail:
      "Completion metrics, throughput logs, and channel performance roll up from the 50 Independent Directors to HERMES for fleet-level reporting back to the OWNER.",
  },
] as const;

export function getInitialDelegationPolicies(): DelegationPolicyItem[] {
  return [
    {
      id: "del-01",
      category: "Creative & routine production",
      disposition: "hermes_decide",
      summary: "HERMES may decide and unblock routine creative production steps.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-02",
      category: "Scheduling & team assignment",
      disposition: "hermes_decide",
      summary: "HERMES may balance episode slots and specialist team capacity.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-03",
      category: "Routine retries & reversible operations",
      disposition: "hermes_decide",
      summary: "HERMES may execute bounded retries, failover routing, and safe rollbacks.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-04",
      category: "Quality rejection & safety refusal",
      disposition: "hermes_decide",
      summary: "HERMES may reject failed QC artifacts or refuse policy-violating outputs.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-05",
      category: "Approved budget allocation",
      disposition: "hermes_within_limits",
      summary: "HERMES may allocate pre-approved provider quotas within hard ceilings.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-06",
      category: "Cross-Director coordination",
      disposition: "hermes_within_limits",
      summary: "HERMES may coordinate shared infrastructure within explicit policy.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: true,
    },
    {
      id: "del-07",
      category: "Live publishing",
      disposition: "explicit_policy_only",
      summary:
        "Requires valid unexpired Owner approval unless an explicit delegated publishing policy is active.",
      lockedOwnerOnly: false,
      delegatedWhenUnavailable: false,
    },
    {
      id: "del-08",
      category: "New paid services or spending above limits",
      disposition: "owner_only",
      summary: "Strictly Owner-only. Blocked regardless of response timeout.",
      lockedOwnerOnly: true,
      delegatedWhenUnavailable: false,
    },
    {
      id: "del-09",
      category: "New account connections or credential ownership",
      disposition: "owner_only",
      summary: "Strictly Owner-only. Vault bindings & OAuth grants cannot be delegated.",
      lockedOwnerOnly: true,
      delegatedWhenUnavailable: false,
    },
    {
      id: "del-10",
      category: "Security & global governance changes",
      disposition: "owner_only",
      summary: "Strictly Owner-only. Lower layers cannot weaken security or constitution rules.",
      lockedOwnerOnly: true,
      delegatedWhenUnavailable: false,
    },
    {
      id: "del-11",
      category: "Destructive deletion & ownership transfer",
      disposition: "owner_only",
      summary: "Strictly Owner-only. Requires direct authenticated Owner action.",
      lockedOwnerOnly: true,
      delegatedWhenUnavailable: false,
    },
    {
      id: "del-12",
      category: "Other expressly reserved decisions",
      disposition: "owner_only",
      summary: "Strictly Owner-only. Silence is never treated as consent.",
      lockedOwnerOnly: true,
      delegatedWhenUnavailable: false,
    },
  ];
}

export const CAPABILITY_DOMAINS: CapabilityDomain[] = [
  { id: "ST-01", title: "Identity & Organization", summary: "Owner, FORGE, HERMES, 50 Independent Directors, teams, agents and service identities.", status: "demo_fixture" },
  { id: "ST-02", title: "Governance & Authority", summary: "Roles, delegation engine, approvals, limits and Owner-reserved decision rights.", status: "policy_gated" },
  { id: "ST-03", title: "Intelligence & Reasoning", summary: "Planning, analysis, decision-making and problem-solving loops.", status: "target_blueprint" },
  { id: "ST-04", title: "Models & Providers", summary: "3 remote slots + 1 local emergency slot across LLMs, image, video, audio & speech.", status: "demo_fixture" },
  { id: "ST-05", title: "Context Engineering", summary: "Dynamic 10-layer context stack respecting provenance, freshness and untrusted-data walls.", status: "target_blueprint" },
  { id: "ST-06", title: "Memory & Knowledge", summary: "Persistent, M0–M6 isolated, searchable creative and operational memory.", status: "demo_fixture" },
  { id: "ST-07", title: "Skills", summary: "Versioned reusable specialist capability packages (S0–S9 hierarchy).", status: "target_blueprint" },
  { id: "ST-08", title: "Tools & Toolsets", summary: "Internal, external and developer executable tools behind T0–T7 permission checks.", status: "target_blueprint" },
  { id: "ST-09", title: "Messaging & Communication", summary: "Durable Owner, HERMES, Director and team messaging with delivery states.", status: "demo_fixture" },
  { id: "ST-10", title: "Automation & Orchestration", summary: "Event-driven, scheduled and conditional autonomous execution lifecycles.", status: "demo_fixture" },
  { id: "ST-11", title: "Browser & Web Intelligence", summary: "B0–B5 isolated browser sessions for research and controlled web actions.", status: "target_blueprint" },
  { id: "ST-12", title: "MCP & Interoperability", summary: "ST MCP Gateway & 8 domain MCP servers enforcing independent authorization.", status: "target_blueprint" },
  { id: "ST-13", title: "Workflow & Process Engine", summary: "14-step durable production workflows, canonical 1 main + 2 shorts + 1 brand reel.", status: "demo_fixture" },
  { id: "ST-14", title: "Data & Storage", summary: "PostgreSQL, object storage, vector store, search index, cache, event & evidence stores.", status: "target_blueprint" },
  { id: "ST-15", title: "Evidence & Audit", summary: "Verifiable SHA-256 artifacts, FFprobe reports, QC receipts and immutable audit logs.", status: "demo_fixture" },
  { id: "ST-16", title: "Security & Privacy", summary: "Auth, MFA, RBAC, Director tenant isolation, vault:// secrets and CSRF protection.", status: "policy_gated" },
  { id: "ST-17", title: "Reliability & Recovery", summary: "Durable leases, idempotency keys, exponential backoff retries, watchdogs & DLQs.", status: "target_blueprint" },
  { id: "ST-18", title: "Observability & Monitoring", summary: "Executive dashboards, logs, traces, alerts, latency and quota telemetry.", status: "demo_fixture" },
  { id: "ST-19", title: "Cost & Resource Management", summary: "Per-Director quotas, zero-overage free-tier routing and Owner spend gates.", status: "policy_gated" },
  { id: "ST-20", title: "Deployment & Infrastructure", summary: "Always-on cloud runtime independent of Owner Chromebook, laptop or Codespaces.", status: "target_blueprint" },
  { id: "ST-21", title: "Media Production Engine", summary: "Research, script, voice, visuals, motion, FFmpeg assembly, FFprobe and QC gate.", status: "demo_fixture" },
  { id: "ST-22", title: "Publishing & Distribution", summary: "Director-owned accounts across YouTube, Shorts, Instagram, Facebook, Snapchat & Bilibili.", status: "policy_gated" },
  { id: "ST-23", title: "Analytics & Optimization", summary: "Audience retention, watch time, thumbnail experiments and growth diagnostics.", status: "target_blueprint" },
  { id: "ST-24", title: "Learning & Evolution", summary: "Negative memory capture, regression evals and controlled skill upgrades.", status: "target_blueprint" },
];

export const MEMORY_HIERARCHY: MemoryLayerSpec[] = [
  { code: "M0", title: "Owner Memory", scope: "Owner preferences, governance decisions & studio-wide intent", isolation: "Owner-scoped" },
  { code: "M1", title: "Organization Memory", scope: "ST policies, architecture standards, shared procedures", isolation: "Org-wide read" },
  { code: "M2", title: "HERMES Executive Memory", scope: "Director health, delegated authority logs, escalations & risks", isolation: "HERMES-scoped" },
  { code: "M3", title: "Director Memory", scope: "Universe bible, IP, characters, style, script history & mistakes", isolation: "Isolated per Director" },
  { code: "M4", title: "Team Memory", scope: "Specialist team procedures, expertise & execution notes", isolation: "Team-scoped" },
  { code: "M5", title: "Project & Production Memory", scope: "Episodes, assets, scripts, production runs & QC verdicts", isolation: "Project-scoped" },
  { code: "M6", title: "Operational & Evidence Memory", scope: "Events, logs, metrics, incidents, hashes & publishing receipts", isolation: "Immutable audit" },
];

export const MEMORY_TYPES = [
  "Semantic (facts & knowledge)",
  "Episodic (what happened & when)",
  "Procedural (how to execute tasks)",
  "Creative (lore, characters & style)",
  "Technical (code, tools & APIs)",
  "Operational (queues & run history)",
  "Evidence (verifiable receipts & hashes)",
  "Preference (authorized style choices)",
  "Negative (failures & known mistakes)",
  "Temporal (active vs superseded records)",
];

export const TOOL_PERMISSION_LEVELS: PermissionLevelSpec[] = [
  { code: "T0", label: "Discover", example: "Find available tools and schemas" },
  { code: "T1", label: "Read", example: "Read repository, records or analytics" },
  { code: "T2", label: "Analyze", example: "Compare, diagnose and recommend fixes" },
  { code: "T3", label: "Prepare", example: "Create draft, plan or proposed diff" },
  { code: "T4", label: "Reversible execution", example: "Run safe, reversible internal operations" },
  { code: "T5", label: "Controlled modification", example: "Modify approved code or operational records" },
  { code: "T6", label: "External side effect", example: "Send, publish, upload or connect external API" },
  { code: "T7", label: "Owner-restricted", example: "Spending, deletion, ownership & security changes" },
];

export const BROWSER_LEVELS: PermissionLevelSpec[] = [
  { code: "B0", label: "No browser access", example: "Purely offline / internal worker context" },
  { code: "B1", label: "Search & discover", example: "Query search engines and indexes" },
  { code: "B2", label: "Read & summarize", example: "Inspect public websites and API docs" },
  { code: "B3", label: "Navigate & collect", example: "Follow multi-page structured research" },
  { code: "B4", label: "Fill & prepare", example: "Stage forms without submitting side effects" },
  { code: "B5", label: "Controlled action", example: "Execute approved web actions with isolated Director profiles & receipts" },
];

export const MCP_SERVERS = [
  { name: "Internal MCP", responsibility: "Directors, tasks, projects and ST services" },
  { name: "Research MCP", responsibility: "Search, sources, research and verification" },
  { name: "Developer MCP", responsibility: "GitHub, code, testing and CI pipelines" },
  { name: "Media MCP", responsibility: "Image, video, voice and audio operations" },
  { name: "Communication MCP", responsibility: "Messaging, email and notifications" },
  { name: "Publishing MCP", responsibility: "Director accounts, scheduling and receipts" },
  { name: "Data MCP", responsibility: "Authorized database and object storage access" },
  { name: "Operations MCP", responsibility: "Health, logs, queues and recovery" },
];

export const DIRECTOR_STUDIO_BLUEPRINT = [
  "Director identity and charter",
  "Independent universe and intellectual property",
  "Genres, niches and micro-niches",
  "Languages and localization",
  "Audience and creative strategy",
  "Independent context and memory (M3)",
  "Dedicated production teams",
  "Skills and tool permissions",
  "Projects, queues and schedules",
  "Production workflow and quality standards",
  "Dedicated publishing accounts (6 platforms)",
  "Credentials and integration health",
  "Content catalogue and asset storage",
  "Analytics and growth intelligence",
  "Evidence, audit and performance history",
  "Budget, quota and resource allocation",
  "Approval and escalation rules",
  "HERMES management and reporting connection",
];

export const IMPLEMENTATION_PHASES: ImplementationPhaseSpec[] = [
  { phase: 0, title: "Repository and architecture audit", outcome: "Accurate baseline and verified gaps", status: "baseline_audit" },
  { phase: 1, title: "Identity, ownership and governance", outcome: "Enforced organizational hierarchy", status: "demo_modeled" },
  { phase: 2, title: "Director isolation", outcome: "Independent identity, memory, universe and accounts model", status: "demo_modeled" },
  { phase: 3, title: "HERMES management and delegation", outcome: "Auditable executive authority and Owner-unavailability handling", status: "demo_modeled" },
  { phase: 4, title: "Database, storage and evidence", outcome: "Durable, isolated and traceable data", status: "target_phase" },
  { phase: 5, title: "Tools and permission gateway", outcome: "Secure T0–T7 tool execution", status: "target_phase" },
  { phase: 6, title: "Memory, context and skills", outcome: "Reliable specialist intelligence", status: "target_phase" },
  { phase: 7, title: "Messaging and collaboration", outcome: "Durable communication and handoffs", status: "demo_modeled" },
  { phase: 8, title: "Automation and workflow engine", outcome: "Recoverable autonomous execution", status: "target_phase" },
  { phase: 9, title: "Browser and MCP", outcome: "Governed external connectivity", status: "target_phase" },
  { phase: 10, title: "Media production engine", outcome: "Verified end-to-end media production", status: "target_phase" },
  { phase: 11, title: "Publishing and analytics", outcome: "Independent Director publishing and measurement", status: "target_phase" },
  { phase: 12, title: "Cloud deployment", outcome: "Persistent independent runtime (off local laptop/Codespaces)", status: "target_phase" },
  { phase: 13, title: "Monitoring, backups and recovery", outcome: "Operational reliability & restore drills", status: "target_phase" },
  { phase: 14, title: "Advanced autonomy", outcome: "Safe executive and production autonomy", status: "target_phase" },
  { phase: 15, title: "Scaling and optimization", outcome: "Multi-Director enterprise operations (up to 50 Directors)", status: "target_phase" },
];

export const OPERATING_PRINCIPLES = [
  { num: 1, title: "Owner supremacy", text: "The Owner has final authority over ST." },
  { num: 2, title: "Delegated executive authority", text: "HERMES can act when Owner is unavailable, strictly within explicit delegation." },
  { num: 3, title: "No assumed consent", text: "Silence or expired requests never automatically authorize an action." },
  { num: 4, title: "Independent Directors", text: "Each Director owns its own universe and creative identity." },
  { num: 5, title: "Independent memory", text: "Director context and memory are isolated by default (M3)." },
  { num: 6, title: "Independent production", text: "Each Director controls its own creative plans and specialist teams." },
  { num: 7, title: "Independent publishing", text: "Each Director holds separate platform accounts and credentials." },
  { num: 8, title: "Shared infrastructure, isolated ownership", text: "Services can be shared without merging private data or authority." },
  { num: 9, title: "Permission before execution", text: "No tool or MCP server can bypass its authorization policy." },
  { num: 10, title: "Durable automation", text: "Work survives browser closures, laptop shutdowns and Codespace stops." },
  { num: 11, title: "Honest failures", text: "A broken provider or unavailable integration must fail visibly." },
  { num: 12, title: "Evidence before claims", text: "No unsupported claims of production, rendering, publishing or verification." },
  { num: 13, title: "Quality before distribution", text: "Content must pass applicable FFprobe/QC and approval gates." },
  { num: 14, title: "Cost discipline", text: "No unauthorized spending, subscriptions, or paid overages." },
  { num: 15, title: "Continuous improvement", text: "Evaluates performance and improves without violating ownership or governance." },
];

export const DIRECTOR_PLATFORM_MODEL = [
  { platform: "YouTube", note: "Dedicated channel per Director (Longform 30–50m)" },
  { platform: "YouTube Shorts", note: "Published via the Director's own YouTube channel in Shorts format" },
  { platform: "Instagram", note: "Dedicated isolated account & Reels slot" },
  { platform: "Facebook", note: "Dedicated isolated Page / Reels credential" },
  { platform: "Snapchat", note: "Dedicated isolated Public Profile & Spotlight" },
  { platform: "Bilibili", note: "Dedicated isolated regional publishing slot" },
];
