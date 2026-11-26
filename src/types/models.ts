export type ScreenSection =
  | "overview"
  | "directors"
  | "schedule"
  | "communication"
  | "memory"
  | "production"
  | "jobs"
  | "providers"
  | "connections"
  | "approvals"
  | "notifications"
  | "fleet"
  | "evidence"
  | "hermes"
  | "architecture"
  | "settings";

export interface NavItemConfig {
  id: ScreenSection;
  title: string;
  shortLabel?: string;
}

export const NAV_ITEMS: NavItemConfig[] = [
  { id: "overview", title: "Command Center", shortLabel: "Command" },
  { id: "directors", title: "Directors", shortLabel: "Directors" },
  { id: "schedule", title: "Episode & Schedule", shortLabel: "Schedule" },
  { id: "communication", title: "Director Comm" },
  { id: "memory", title: "Memory & Lore" },
  { id: "production", title: "Production", shortLabel: "Production" },
  { id: "jobs", title: "Active Jobs", shortLabel: "Jobs" },
  { id: "providers", title: "Providers & Quota" },
  { id: "connections", title: "OAuth & Secrets" },
  { id: "approvals", title: "Approvals" },
  { id: "notifications", title: "Inbox & Reports" },
  { id: "fleet", title: "Director Fleet", shortLabel: "Fleet" },
  { id: "evidence", title: "Evidence Ledger" },
  { id: "hermes", title: "Hermes AI Manager" },
  { id: "architecture", title: "Master Architecture" },
  { id: "settings", title: "Settings" },
];

export const CORE_BOTTOM_TABS: ScreenSection[] = [
  "overview",
  "directors",
  "schedule",
  "production",
  "jobs",
];

export const PIPELINE_STAGES = [
  { key: "story", label: "Story & Beats" },
  { key: "visual", label: "Scene Visuals" },
  { key: "audio", label: "Voice & Sound" },
  { key: "assembly", label: "FFmpeg Assembly" },
  { key: "reels", label: "Short-Form Reels" },
  { key: "packaging", label: "Packaging" },
  { key: "qc", label: "QC Gate" },
  { key: "complete", label: "Complete" },
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGES)[number]["key"];

export interface Owner {
  id: string;
  email: string;
  role: string;
  isAuthenticated: boolean;
}

export interface Agent {
  id: string;
  name: string;
  namespace: string;
  enabled: boolean;
}

export type MediaSlotStatus = "planned" | "rendering" | "verified" | "published";

export interface MediaSlot {
  key: string;
  label: string;
  hint: string;
  status: MediaSlotStatus;
  artifactTitle: string | null;
  durationSeconds: number | null;
  artifactHash: string | null;
  verified: boolean;
  resolution: string;
  aspectRatio: string;
  lufsAudio: string;
  codec: string;
}

export interface Channel {
  id: string;
  slug: string;
  displayName: string;
  tagline: string;
  language: string;
  agentId: string;
  ownerId: string;
  launchTitle: string;
  activePlatforms: string[];
  slots: MediaSlot[];
}

export type ReleaseStatus =
  | "planned"
  | "in_production"
  | "rendering"
  | "review"
  | "published"
  | "cancelled";

export interface ProductionRelease {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  season: number;
  episode: number;
  status: ReleaseStatus;
  /** Backend status string exactly as returned (never rewritten for display). */
  backendStatus?: string;
  /** Empty string when the backend exposes no pipeline stage for this release. */
  currentStage: PipelineStageKey | "";
  stageProgress: number;
  createdAt: string;
  executionLog: string[];
}

export interface DirectorSchedule {
  agentId: string;
  mainEpisodeDuration: number; // 1800 (30m), 2400 (40m), 3000 (50m)
  episodesPerDay: number;
  productionDays: number[]; // 1=Mon .. 7=Sun
  preferredStartTime: string;
  timezone: string;
  enabled: boolean;
}

export type MessageKind = "conversation" | "proposal" | "instruction" | "decision";
export type MessageSender = "owner" | "director";
export type MessageSource =
  | "owner"
  | "director_ai"
  | "system_delivery_ack"
  | "system_error";

export type DirectorOutcome =
  | "DIRECTOR_RESPONDED"
  | "DIRECTOR_NEEDS_CLARIFICATION"
  | "TASK_ACCEPTED"
  | "TASK_REJECTED_WITH_REASON"
  | "PROVIDER_UNAVAILABLE"
  | "ROUTING_FAILED";

export interface DirectorMessage {
  id: string;
  agentId: string;
  kind: MessageKind;
  sender: MessageSender;
  source?: MessageSource;
  outcome?: DirectorOutcome;
  model?: string;
  clientMessageId?: string;
  body: string;
  timestamp: string;
}

export interface CreativeCharter {
  agentId: string;
  logline: string;
  premise: string;
  visualStyle: string;
  pacing: string;
  targetAudience: string;
  continuityRules: string[];
}

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_for_quota"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "paused";

export interface ProductionJob {
  id: string;
  agentId: string;
  capability: string;
  status: JobStatus;
  progressPercent: number;
  note: string;
  createdAt: string;
}

export type OwnerAvailabilityState = OwnerAvailability | "unknown";

export type ProviderCategory = "Visual" | "Narration" | "Assembly" | "Publisher";
export type ProviderHealthStatus = "healthy" | "cooldown" | "degraded";

export interface ProviderSlot {
  id: string;
  name: string;
  category: ProviderCategory;
  tier: string;
  status: ProviderHealthStatus;
  latencyMs: number;
  dailyQuotaUsedPercent: number;
  cooldownSeconds: number;
}

export type ConnectionSlotStatus =
  | "unconfigured"
  | "sandbox_verified"
  | "live_authenticated";

export interface PlatformConnection {
  id: string;
  agentId: string;
  platform: string;
  status: ConnectionSlotStatus;
  locator: string;
  lastVerified: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalItem {
  id: string;
  artifactHash: string;
  channelName: string;
  title: string;
  destination: string;
  caption: string;
  disclosure: string;
  affiliateLinks: string;
  status: ApprovalStatus;
  createdAt: string;
}

export interface EvidenceEvent {
  id: string;
  eventType: string;
  agentId: string;
  channelSlug: string;
  stage: string;
  artifactHash: string;
  verificationReceipt: string;
  timestamp: string;
}

export interface HermesDecision {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  authorityTier: string;
  timestamp: string;
}

export interface InspectionModalData {
  title: string;
  slotKey: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  lufs: string;
  codec: string;
  sha256: string;
  isVerified: boolean;
}

export type PublishingMode = "dry_run" | "live";

export type OwnerAvailability = "available" | "unavailable";

export type DelegationDisposition =
  | "hermes_decide"
  | "hermes_within_limits"
  | "explicit_policy_only"
  | "owner_only";

export interface DelegationPolicyItem {
  id: string;
  category: string;
  disposition: DelegationDisposition;
  summary: string;
  lockedOwnerOnly: boolean;
  delegatedWhenUnavailable: boolean;
}

export type CapabilityImplementationStatus =
  | "demo_fixture"
  | "policy_gated"
  | "target_blueprint";

export interface CapabilityDomain {
  id: string;
  title: string;
  summary: string;
  status: CapabilityImplementationStatus;
}

export interface MemoryLayerSpec {
  code: string;
  title: string;
  scope: string;
  isolation: string;
}

export interface PermissionLevelSpec {
  code: string;
  label: string;
  example: string;
}

export interface ImplementationPhaseSpec {
  phase: number;
  title: string;
  outcome: string;
  status: "baseline_audit" | "demo_modeled" | "target_phase";
}

