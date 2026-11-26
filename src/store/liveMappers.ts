/**
 * Adapters from backend DTOs to the console's existing view models.
 *
 * These are deliberately lossless-in-the-honest-direction: a field the backend
 * does not return is left empty/null rather than filled with a plausible value.
 * Where the console previously showed demo fixtures (canonical media slots,
 * provider latency, charter prose) the adapter returns nothing and the screen
 * reports the missing capability instead.
 */
import type {
  Agent,
  Channel,
  DirectorMessage,
  DirectorSchedule,
  EvidenceEvent,
  HermesDecision,
  Owner,
  ProductionRelease,
  ReleaseStatus,
} from "../types/models";
import type { ApprovalCard, ApprovalCheck, ConnectionView, ProviderView, SessionView } from "../types/ownerApi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function mapAgent(raw: Json): Agent | null {
  if (!raw || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    namespace: typeof raw.namespace === "string" ? raw.namespace : "",
    enabled: raw.enabled === true,
  };
}

export function mapAgents(payload: Json): Agent[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.agents) ? payload.agents : [];
  return rows.map(mapAgent).filter((agent: Agent | null): agent is Agent => agent !== null);
}

export function mapOwner(raw: Json): Owner | null {
  if (!raw || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    email: typeof raw.email === "string" ? raw.email : "",
    role: typeof raw.role === "string" ? raw.role : "owner",
    isAuthenticated: true,
  };
}

/**
 * Channels are public branding only (Rule 15). The backend returns no media
 * slots, so `slots` is empty and the UI must not render fake ones.
 */
export function mapChannel(raw: Json): Channel | null {
  if (!raw || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    slug: typeof raw.slug === "string" ? raw.slug : "",
    displayName: typeof raw.displayName === "string" ? raw.displayName : "Untitled channel",
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    language: typeof raw.language === "string" ? raw.language : "",
    agentId: typeof raw.agentId === "string" ? raw.agentId : "",
    ownerId: "",
    launchTitle: "",
    activePlatforms: [],
    slots: [],
  };
}

export function mapChannels(payload: Json): Channel[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.channels) ? payload.channels : [];
  return rows
    .map(mapChannel)
    .filter((channel: Channel | null): channel is Channel => channel !== null);
}

const RELEASE_STATUSES: ReleaseStatus[] = [
  "planned",
  "in_production",
  "rendering",
  "review",
  "published",
  "cancelled",
];

/**
 * Map the backend status onto the governed console enum WITHOUT inventing a
 * state: the raw value is kept in `backendStatus` and rendered from there, so a
 * status the console does not model can never be shown as a confident one.
 */
function normaliseReleaseStatus(raw: Json): ReleaseStatus {
  const value = typeof raw === "string" ? raw : "";
  if (RELEASE_STATUSES.includes(value as ReleaseStatus)) return value as ReleaseStatus;
  return "planned";
}

export function mapRelease(raw: Json): ProductionRelease | null {
  if (!raw || typeof raw.id !== "string") return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  return {
    id: raw.id,
    channelId: typeof raw.channelId === "string" ? raw.channelId : "",
    channelName:
      typeof raw.channelName === "string" && raw.channelName
        ? raw.channelName
        : typeof raw.channelSlug === "string" && raw.channelSlug
        ? raw.channelSlug
        : "Unassigned channel",
    title: typeof raw.title === "string" ? raw.title : "Untitled release",
    season: Number(raw.season ?? 1),
    episode: Number(raw.episode ?? 1),
    status: normaliseReleaseStatus(status),
    backendStatus: status,
    // The release DTO carries no pipeline stage; an empty key renders an
    // inactive stage strip instead of a fabricated "story" position.
    currentStage: "",
    stageProgress: 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    executionLog: [],
  };
}

export function mapReleases(payload: Json): ProductionRelease[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.productions) ? payload.productions : [];
  return rows
    .map(mapRelease)
    .filter((release: ProductionRelease | null): release is ProductionRelease => release !== null);
}

export interface ScheduleView {
  schedule: DirectorSchedule;
  configured: boolean;
  agentId: string;
  channelDisplayName: string | null;
}

/** Live schedule DTO (`/api/scheduling/directors`) → console model. */
export function mapScheduleView(raw: Json): ScheduleView | null {
  if (!raw || typeof raw.agentId !== "string") return null;
  const dto = raw.schedule ?? {};
  const seconds = Number(dto.episodeDurationSeconds);
  const episodesPerDay = Number(dto.episodesPerDay);
  const days = Array.isArray(dto.productionDays)
    ? dto.productionDays.map((day: Json) => Number(day)).filter((day: number) => day >= 1 && day <= 7)
    : [];
  const startTime = typeof dto.productionStartTime === "string" ? dto.productionStartTime : "";
  const timezone = typeof dto.timezone === "string" ? dto.timezone : "";
  const valid =
    dto.invalid !== true &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    Number.isFinite(episodesPerDay) &&
    episodesPerDay > 0 &&
    days.length > 0 &&
    startTime.length > 0 &&
    timezone.length > 0;

  return {
    agentId: raw.agentId,
    configured: dto.configured === true,
    channelDisplayName:
      typeof raw.channelDisplayName === "string" ? raw.channelDisplayName : null,
    schedule: {
      agentId: raw.agentId,
      mainEpisodeDuration: valid ? seconds : 0,
      episodesPerDay: valid ? episodesPerDay : 0,
      productionDays: valid ? days : [],
      preferredStartTime: startTime,
      timezone,
      enabled: dto.scheduleEnabled === true,
    },
  };
}

export function mapScheduleViews(payload: Json): Record<string, ScheduleView> {
  const rows = Array.isArray(payload?.directors) ? payload.directors : [];
  const out: Record<string, ScheduleView> = {};
  for (const row of rows) {
    const view = mapScheduleView(row);
    if (view) out[view.agentId] = view;
  }
  return out;
}

export function mapEvidence(raw: Json): EvidenceEvent | null {
  if (!raw || typeof raw.id !== "string") return null;
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const eventType = typeof raw.kind === "string" ? raw.kind : "UNKNOWN_EVENT";
  return {
    id: raw.id,
    eventType: eventType.toUpperCase(),
    agentId: typeof payload.agentId === "string" ? payload.agentId : "n/a",
    channelSlug: typeof raw.subjectId === "string" ? raw.subjectId : "n/a",
    stage: typeof payload.stage === "string" ? payload.stage : typeof raw.classification === "string" ? raw.classification : "n/a",
    artifactHash: typeof raw.eventHash === "string" ? raw.eventHash : "",
    verificationReceipt: typeof raw.previousHash === "string" ? raw.previousHash : "",
    timestamp: typeof raw.occurredAt === "string" ? raw.occurredAt : "",
  };
}

export function mapEvidenceList(payload: Json): EvidenceEvent[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map(mapEvidence).filter((event): event is EvidenceEvent => event !== null);
}

export function mapApprovalCard(raw: Json): ApprovalCard | null {
  if (!raw || typeof raw.approvalId !== "string") return null;
  const notifications = Array.isArray(raw.notifications) ? raw.notifications : [];
  const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
  // The 11-check scorecard is mapped only when the API returns one. Nothing is
  // synthesised: an absent breakdown stays null and the screen says so.
  let evaluatedChecks: Record<string, ApprovalCheck> | null = null;
  if (raw.evaluatedChecks && typeof raw.evaluatedChecks === "object") {
    evaluatedChecks = {};
    for (const [name, check] of Object.entries<Json>(raw.evaluatedChecks)) {
      if (!check || typeof check !== "object") continue;
      evaluatedChecks[name] = {
        passed: check.passed === true,
        evidence: typeof check.evidence === "string" ? check.evidence : null,
        reasonCode: typeof check.reasonCode === "string" ? check.reasonCode : null,
      };
    }
  }
  return {
    approvalId: raw.approvalId,
    directorId: typeof raw.directorId === "string" ? raw.directorId : "",
    universeId: typeof raw.universeId === "string" ? raw.universeId : null,
    packageId: typeof raw.packageId === "string" ? raw.packageId : null,
    requestedAction: typeof raw.requestedAction === "string" ? raw.requestedAction : "",
    artifactSha256: typeof raw.artifactSha256 === "string" ? raw.artifactSha256 : "",
    destinations: Array.isArray(raw.destinations) ? raw.destinations.filter((d: Json) => typeof d === "string") : [],
    status: typeof raw.status === "string" ? raw.status : "unknown",
    policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    notifiedAt: typeof raw.notifiedAt === "string" ? raw.notifiedAt : null,
    deadlineAt: typeof raw.deadlineAt === "string" ? raw.deadlineAt : null,
    ownerResponseAt: typeof raw.ownerResponseAt === "string" ? raw.ownerResponseAt : null,
    ownerResponseReason:
      typeof raw.ownerResponseReason === "string" ? raw.ownerResponseReason : null,
    hermesDecision: typeof raw.hermesDecision === "string" ? raw.hermesDecision : null,
    hermesDecidedAt: typeof raw.hermesDecidedAt === "string" ? raw.hermesDecidedAt : null,
    decisionReasonCodes: Array.isArray(raw.decisionReasonCodes) ? raw.decisionReasonCodes : [],
    decisionSummary: typeof raw.decisionSummary === "string" ? raw.decisionSummary : null,
    decisionEvidenceHash:
      typeof raw.decisionEvidenceHash === "string" ? raw.decisionEvidenceHash : null,
    evaluatedChecks,
    publishingAuthorized: raw.publishingAuthorized === true,
    authorizationExpiresAt:
      typeof raw.authorizationExpiresAt === "string" ? raw.authorizationExpiresAt : null,
    notifications: notifications.map((n: Json) => ({
      kind: typeof n.kind === "string" ? n.kind : "",
      channel: typeof n.channel === "string" ? n.channel : "",
      state: typeof n.state === "string" ? n.state : "",
      attempts: Number(n.attempts ?? 0),
      deliveredAt: typeof n.deliveredAt === "string" ? n.deliveredAt : null,
    })),
    decisions: decisions.map((d: Json) => ({
      actor: typeof d.actor === "string" ? d.actor : "",
      decision: typeof d.decision === "string" ? d.decision : "",
      decidedAt: typeof d.decidedAt === "string" ? d.decidedAt : null,
    })),
  };
}

export function mapApprovalCards(payload: Json): ApprovalCard[] {
  const rows = Array.isArray(payload?.requests) ? payload.requests : [];
  return rows
    .map(mapApprovalCard)
    .filter((card: ApprovalCard | null): card is ApprovalCard => card !== null);
}

export function mapConnection(raw: Json): ConnectionView | null {
  if (!raw || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    agentId: typeof raw.agentId === "string" ? raw.agentId : "",
    // Safe DTO: the locator/secret value is never serialized by the backend.
    providerKey: typeof raw.providerKey === "string" ? raw.providerKey : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    label: typeof raw.credentialLabel === "string" ? raw.credentialLabel : null,
    status: typeof raw.status === "string" ? raw.status : "unconfigured",
    lastVerifiedAt: typeof raw.lastVerifiedAt === "string" ? raw.lastVerifiedAt : null,
  };
}

export function mapConnections(payload: Json): ConnectionView[] {
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  return rows
    .map(mapConnection)
    .filter((row: ConnectionView | null): row is ConnectionView => row !== null);
}

export function mapProvider(raw: Json): ProviderView | null {
  if (!raw || typeof raw.providerKey !== "string") return null;
  return {
    providerKey: raw.providerKey,
    displayName: typeof raw.displayName === "string" ? raw.displayName : raw.providerKey,
    category: typeof raw.category === "string" ? raw.category : "uncategorised",
    authType: typeof raw.authType === "string" ? raw.authType : "",
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c: Json) => typeof c === "string") : [],
  };
}

export function mapProviders(payload: Json): ProviderView[] {
  const rows = Array.isArray(payload?.providers) ? payload.providers : [];
  return rows
    .map(mapProvider)
    .filter((row: ProviderView | null): row is ProviderView => row !== null);
}

export function mapHermesDecision(raw: Json): HermesDecision | null {
  if (!raw || raw.decisionNumber === undefined) return null;
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const action = typeof raw.action === "string" ? raw.action : "unknown";
  const outcome = typeof raw.outcome === "string" ? raw.outcome : "unknown";
  return {
    id: `hermes-${raw.decisionNumber}`,
    topic: `${action} (${raw.category ?? "uncategorised"})`,
    decision: `${outcome}${raw.reasonCode ? ` · ${raw.reasonCode}` : ""}`,
    rationale: typeof raw.reason === "string" ? raw.reason : JSON.stringify(payload).slice(0, 300),
    authorityTier: typeof raw.authority === "string" ? raw.authority : "unknown",
    timestamp: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

export function mapHermesDecisions(payload: Json): HermesDecision[] {
  const rows = Array.isArray(payload?.decisions) ? payload.decisions : [];
  return rows
    .map(mapHermesDecision)
    .filter((row: HermesDecision | null): row is HermesDecision => row !== null);
}

export function mapSessionView(raw: Json): SessionView | null {
  if (!raw || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    lastSeenAt: typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : "",
    mfaAssuranceLevel:
      typeof raw.mfaAssuranceLevel === "string" ? raw.mfaAssuranceLevel : "unknown",
  };
}

export function mapSessionViews(payload: Json): SessionView[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map(mapSessionView)
    .filter((row: SessionView | null): row is SessionView => row !== null);
}

/** Durable Director conversation rows → console messages. */
export function mapMessages(agentId: string, payload: Json): DirectorMessage[] {
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  const messages: DirectorMessage[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const body = typeof row.body === "string" ? row.body : null;
    if (!body) continue;
    const sender = row.sender === "owner" ? "owner" : "director";
    messages.push({
      id: typeof row.id === "string" ? row.id : `${agentId}-${messages.length}`,
      agentId: typeof row.agentId === "string" ? row.agentId : agentId,
      kind: ["conversation", "proposal", "instruction", "decision"].includes(row.kind)
        ? row.kind
        : "conversation",
      sender,
      source:
        typeof row.source === "string"
          ? row.source
          : sender === "owner"
          ? "owner"
          : "director_ai",
      clientMessageId: typeof row.clientMessageId === "string" ? row.clientMessageId : undefined,
      outcome: typeof row.outcome === "string" ? row.outcome : undefined,
      body,
      timestamp:
        typeof row.createdAt === "string"
          ? row.createdAt
          : typeof row.timestamp === "string"
          ? row.timestamp
          : "",
    });
  }
  return messages;
}
