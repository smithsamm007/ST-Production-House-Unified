/**
 * Backend DTO view types used by the console.
 *
 * These mirror the real API responses (see src/api/ownerConsoleApi.js). Nothing
 * here is a placeholder: a field the backend omits is `null`, not invented.
 */

export interface MetricsDto {
  timestamp: string;
  storage: string;
  agents: number;
  jobsByStatus: Record<string, number>;
  evidenceEvents: number;
  activeSessions: number;
  channels: number;
  process?: {
    uptimeSeconds: number;
    memoryRssMb: number;
    nodeVersion: string;
  };
}

export interface HealthDto {
  status: string;
  storage: string;
  isDemoStorage: boolean;
  oauthSecretManager?: { declared: boolean; bound: boolean; nonDurable: boolean };
  timestamp?: string;
}

export interface ReadyDto {
  status: string;
  database: { status: string };
  storage?: string;
}

export interface SessionView {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  mfaAssuranceLevel: string;
}

export interface ApprovalCheck {
  passed: boolean;
  evidence?: string | null;
  reasonCode?: string | null;
}

export interface ApprovalCard {
  approvalId: string;
  directorId: string;
  universeId: string | null;
  packageId: string | null;
  requestedAction: string;
  artifactSha256: string;
  destinations: string[];
  status: string;
  policyVersion: string;
  createdAt: string | null;
  notifiedAt: string | null;
  deadlineAt: string | null;
  ownerResponseAt: string | null;
  ownerResponseReason: string | null;
  hermesDecision: string | null;
  hermesDecidedAt: string | null;
  decisionReasonCodes: string[];
  decisionSummary: string | null;
  decisionEvidenceHash: string | null;
  /** Present only when the API actually returns a per-check breakdown. */
  evaluatedChecks: Record<string, ApprovalCheck> | null;
  publishingAuthorized: boolean;
  authorizationExpiresAt: string | null;
  notifications: {
    kind: string;
    channel: string;
    state: string;
    attempts: number;
    deliveredAt: string | null;
  }[];
  decisions: { actor: string; decision: string; decidedAt: string | null }[];
}

export interface ConnectionView {
  id: string;
  agentId: string;
  providerKey: string;
  kind: string;
  label: string | null;
  status: string;
  lastVerifiedAt: string | null;
}

export interface ProviderView {
  providerKey: string;
  displayName: string;
  category: string;
  authType: string;
  capabilities: string[];
}

export interface HermesOverviewDto {
  decisions: Record<string, number>;
  byCategory: Record<string, number>;
  blockedRefusals: number;
  pendingOwnerApproval: number;
  lastDecisionNumber: number;
}

export interface MemoryEntryDto {
  id?: string;
  category: string;
  content: string;
  updatedAt?: string | null;
}

export interface DirectorMemoryDto {
  agentId: string;
  memory: MemoryEntryDto[];
}
