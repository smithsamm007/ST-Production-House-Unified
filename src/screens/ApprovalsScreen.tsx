import React, { useCallback, useEffect, useState } from "react";
import { Clock, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { ApprovalItem } from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

interface ApprovalsScreenProps {
  approvals: ApprovalItem[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

interface EvaluatedCheck {
  passed: boolean;
  evidence?: string | null;
  reasonCode?: string | null;
}

interface BackendApproval {
  approvalId: string;
  directorId: string;
  universeId: string | null;
  packageId: string | null;
  requestedAction: string;
  artifactSha256: string;
  destinations: string[];
  policyVersion: string;
  delegatedPolicyId: string | null;
  status: string;
  createdAt: string | null;
  notifiedAt: string | null;
  deadlineAt: string | null;
  ownerResponseAt: string | null;
  ownerResponseReason: string | null;
  hermesDecision: "APPROVE" | "REJECT" | null;
  hermesDecidedAt: string | null;
  decisionReasonCodes: string[];
  decisionSummary: string | null;
  evaluatedChecks: Record<string, EvaluatedCheck> | null;
  decisionEvidenceHash: string | null;
  publishingAuthorized: boolean;
  authorizationExpiresAt: string | null;
}

function formatRemainingWindow(deadlineIso: string | null, nowMs: number): string {
  if (!deadlineIso) return "Notification pending";
  const deadlineMs = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadlineMs)) return "Invalid deadline";
  const diff = deadlineMs - nowMs;
  if (diff <= 0) return "5h window elapsed — awaiting HERMES cycle";
  const totalSec = Math.floor(diff / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(
    secs
  ).padStart(2, "0")} remaining`;
}

export const ApprovalsScreen: React.FC<ApprovalsScreenProps> = ({
  approvals,
  onApprove,
  onReject,
}) => {
  const [liveRequests, setLiveRequests] = useState<BackendApproval[] | null>(null);
  const [backendNotice, setBackendNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningDeadline, setRunningDeadline] = useState(false);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const fetchCsrfToken = async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return typeof data?.csrfToken === "string" ? data.csrfToken : null;
    } catch {
      return null;
    }
  };

  const loadLiveApprovals = useCallback(async () => {
    setActionError(null);
    try {
      const res = await fetch("/api/publishing-approvals/requests", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setLiveRequests(null);
        if (res.status === 401 || res.status === 403) {
          setBackendNotice(
            "Sign in with an authenticated server session to manage durable D5 publishing approvals. Showing local preview items below."
          );
        } else {
          setBackendNotice(
            `Durable D5 publishing approvals unavailable (HTTP ${res.status}). Showing local preview items below.`
          );
        }
        return;
      }
      const data = await res.json().catch(() => null);
      setLiveRequests(Array.isArray(data?.requests) ? data.requests : []);
      setBackendNotice(null);
    } catch {
      setLiveRequests(null);
      setBackendNotice(
        "Control-plane approvals API is unreachable from this session. Showing local preview items below."
      );
    }
  }, []);

  useEffect(() => {
    void loadLiveApprovals();
  }, [loadLiveApprovals]);

  const handleBackendDecision = async (
    item: BackendApproval,
    decision: "APPROVE" | "REJECT" | "CHANGES_REQUESTED"
  ) => {
    setBusyId(item.approvalId);
    setActionError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const res = await fetch(
        `/api/publishing-approvals/requests/${encodeURIComponent(
          item.approvalId
        )}/owner-decision`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify({
            decision,
            artifactSha256: item.artifactSha256,
            reason: reasonById[item.approvalId]?.trim() || undefined,
          }),
        }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(data?.message || data?.code || `HTTP ${res.status}`);
        return;
      }
      await loadLiveApprovals();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleRunDeadlineCycle = async () => {
    setRunningDeadline(true);
    setActionError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const res = await fetch("/api/publishing-approvals/deadline/run", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setActionError(data?.message || data?.code || `HTTP ${res.status}`);
        return;
      }
      await loadLiveApprovals();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Deadline run failed");
    } finally {
      setRunningDeadline(false);
    }
  };

  const getTone = (status: string): StatusTone => {
    const normalized = status.toLowerCase();
    if (normalized === "approved" || normalized.includes("approved")) return "ok";
    if (
      normalized === "rejected" ||
      normalized.includes("rejected") ||
      normalized === "withdrawn"
    )
      return "bad";
    return "warn";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            Live Publishing Approvals &amp; 5-Hour HERMES Delegation (Rule 7 / D5)
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5 max-w-3xl">
            Live publishing requires valid Owner approval bound to the exact
            artifact SHA-256, destination, and disclosure. After a 5-hour Owner
            response window elapses, HERMES evaluates all 11 QC/safety checks and
            records an explicit APPROVE or REJECT decision — silence is never
            assumed as consent.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {liveRequests !== null && (
            <button
              type="button"
              onClick={handleRunDeadlineCycle}
              disabled={runningDeadline}
              className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#22D3EE] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {runningDeadline ? "Evaluating..." : "Run HERMES Deadline Check"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadLiveApprovals()}
            className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {backendNotice && (
        <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-lg px-4 py-2.5 text-xs text-[#FBBF24]">
          {backendNotice}
        </div>
      )}

      {actionError && (
        <div role="alert" className="bg-[#0D1420] border border-[#F87171]/50 rounded-lg px-4 py-2.5 text-xs text-[#F87171]">
          {actionError}
        </div>
      )}

      {/* Durable D5 Approval Queue when authenticated + PG connected */}
      {liveRequests !== null ? (
        liveRequests.length === 0 ? (
          <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
            No durable D5 publishing approval requests recorded yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {liveRequests.map((item) => {
              const awaiting = item.status === "AWAITING_OWNER" || item.status === "PENDING_NOTIFICATION";
              const checkEntries = item.evaluatedChecks
                ? Object.entries(item.evaluatedChecks)
                : [];
              return (
                <div
                  key={item.approvalId}
                  className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold font-display text-[#E8EEF8]">
                        Director {item.directorId}
                        {item.packageId ? ` · Package ${item.packageId}` : ""}
                      </h2>
                      <p className="text-xs text-[#22D3EE] mt-0.5">
                        Destinations: {item.destinations.join(", ")} · Policy v
                        {item.policyVersion}
                      </p>
                    </div>
                    <StatusBadge
                      label={item.status}
                      tone={getTone(item.status)}
                    />
                  </div>

                  {awaiting && (
                    <div className="bg-[#101A2B] border border-[#FBBF24]/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-[#FBBF24] font-medium">
                        <Clock className="w-3.5 h-3.5" />
                        Owner Response Window (5h)
                      </span>
                      <span className="font-mono text-[#E8EEF8] tabular-nums">
                        {formatRemainingWindow(item.deadlineAt, nowMs)}
                      </span>
                    </div>
                  )}

                  <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 font-mono text-[11px] text-[#8D9AB3] break-all select-all">
                    Artifact SHA-256: {item.artifactSha256}
                  </div>

                  {item.decisionSummary && (
                    <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-lg p-3 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#22D3EE]">
                          HERMES Decision: {item.hermesDecision ?? item.status}
                        </span>
                        <span className="text-[11px] font-mono text-[#8D9AB3]">
                          Authorized: {item.publishingAuthorized ? "YES" : "NO"}
                        </span>
                      </div>
                      <p className="text-[#E8EEF8] leading-relaxed">
                        {item.decisionSummary}
                      </p>
                      {item.decisionReasonCodes.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {item.decisionReasonCodes.map((code) => (
                            <span
                              key={code}
                              className="px-2 py-0.5 rounded bg-[#0D1420] border border-[#1E2A40] font-mono text-[10px] text-[#FBBF24]"
                            >
                              {code}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {checkEntries.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-[#8D9AB3] uppercase tracking-wider">
                        HERMES 11-Check Verification Scorecard
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {checkEntries.map(([name, chk]) => (
                          <div
                            key={name}
                            className="flex items-center justify-between gap-2 bg-[#101A2B] border border-[#1E2A40] rounded px-2.5 py-1.5 text-[11px]"
                          >
                            <span className="text-[#E8EEF8] truncate">{name}</span>
                            {chk.passed ? (
                              <span className="inline-flex items-center gap-1 text-[#34D399] font-semibold shrink-0">
                                <ShieldCheck className="w-3.5 h-3.5" />
                                PASS
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[#F87171] font-semibold shrink-0">
                                <ShieldX className="w-3.5 h-3.5" />
                                {chk.reasonCode || "FAIL"}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {awaiting && (
                    <div className="space-y-2.5 pt-1">
                      <input
                        type="text"
                        maxLength={500}
                        value={reasonById[item.approvalId] ?? ""}
                        onChange={(e) =>
                          setReasonById((prev) => ({
                            ...prev,
                            [item.approvalId]: e.target.value,
                          }))
                        }
                        placeholder="Optional Owner decision note / change request..."
                        className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-xs text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          disabled={busyId === item.approvalId}
                          onClick={() => void handleBackendDecision(item, "APPROVE")}
                          className="py-2 px-3 rounded-lg bg-[#34D399] hover:bg-[#29BA84] disabled:opacity-50 text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busyId === item.approvalId}
                          onClick={() =>
                            void handleBackendDecision(item, "CHANGES_REQUESTED")
                          }
                          className="py-2 px-3 rounded-lg border border-[#FBBF24]/50 hover:bg-[#FBBF24]/10 disabled:opacity-50 text-[#FBBF24] text-xs font-semibold transition-colors cursor-pointer"
                        >
                          Changes
                        </button>
                        <button
                          type="button"
                          disabled={busyId === item.approvalId}
                          onClick={() => void handleBackendDecision(item, "REJECT")}
                          className="py-2 px-3 rounded-lg border border-[#F87171]/50 hover:bg-[#F87171]/10 disabled:opacity-50 text-[#F87171] text-xs font-semibold transition-colors cursor-pointer"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : approvals.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
          No publication approvals pending.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {approvals.map((item) => (
            <div
              key={item.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold font-display text-[#E8EEF8]">
                    {item.title}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5">
                    {item.channelName} · Destination: {item.destination}
                  </p>
                </div>
                <StatusBadge label={item.status} tone={getTone(item.status)} />
              </div>

              <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 font-mono text-[11px] text-[#8D9AB3] break-all select-all">
                Artifact Hash: {item.artifactHash}
              </div>

              <div className="space-y-1">
                <div className="text-xs font-semibold text-[#8D9AB3]">
                  Caption
                </div>
                <p className="text-sm text-[#E8EEF8]">{item.caption}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="font-semibold text-[#8D9AB3]">Disclosure</div>
                  <p className="text-[#E8EEF8] mt-0.5">{item.disclosure}</p>
                </div>
                <div>
                  <div className="font-semibold text-[#8D9AB3]">
                    Affiliate Links
                  </div>
                  <p className="text-[#E8EEF8] mt-0.5">{item.affiliateLinks}</p>
                </div>
              </div>

              {item.status === "pending" && (
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => onApprove(item.id)}
                    className="py-2.5 px-4 rounded-lg bg-[#34D399] hover:bg-[#29BA84] text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
                  >
                    Approve for Live Release
                  </button>
                  <button
                    type="button"
                    onClick={() => onReject(item.id)}
                    className="py-2.5 px-4 rounded-lg border border-[#F87171]/50 hover:bg-[#F87171]/10 text-[#F87171] text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
