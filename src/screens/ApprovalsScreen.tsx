import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import type { ApprovalCard } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

/**
 * Publishing approvals.
 *
 * Two capabilities live here and neither replaces the other:
 *
 *  1. main's richer per-request review surface — the durable HERMES decision
 *     record, the 11-check scorecard when the API returns one, the 5-hour Owner
 *     response window, authorization expiry and the notification ledger.
 *  2. Day 2's honest data-source contract — a LIVE/STALE/OFFLINE/UNAVAILABLE
 *     badge, an explicit empty state, and reads routed through the shared
 *     authenticated client instead of a component-local fetch.
 *
 * Approval DECISION controls are deliberately not rendered. The backend routes
 * exist (`POST /requests/:id/owner-decision`, `POST /deadline/run`) but the
 * durable decision workflow has not been separately accepted, so the console
 * states that gap instead of offering a button whose authorization boundary is
 * unproven. Nothing is simulated: every field below is a value the API returned.
 */

interface ApprovalsScreenProps {
  approvals: ApprovalCard[];
  status: DataSourceStatus;
  onRefresh: () => void;
  decisionGap: string;
}

function toneFor(status: string): StatusTone {
  const value = status.toUpperCase();
  if (value.includes("APPROVED") || value.includes("AUTHORIZED")) return "ok";
  if (value.includes("REJECTED") || value.includes("EXPIRED") || value.includes("INVALID")) return "bad";
  return "warn";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Live 5-hour Owner response window (main's countdown, preserved). */
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
  status,
  onRefresh,
  decisionGap,
}) => {
  const connected = status.state === "live" || status.state === "stale";
  const pending = approvals.filter((approval) => approval.status.toUpperCase().includes("PENDING"));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Publishing Approvals (Rule 7)"
        subtitle="Durable HERMES approval requests bound to the exact artifact hash, destinations and policy version. Live publishing requires a valid, unexpired Owner approval."
        status={status}
        onRefresh={onRefresh}
      />

      <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1">
        <div className="text-xs font-bold text-[#22D3EE]">Decision authority</div>
        <p className="text-xs text-[#8D9AB3] leading-relaxed">{decisionGap}</p>
        <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
          Decision controls (approve / request changes / reject, and the HERMES deadline cycle) are
          not available from this console until the durable decision workflow is separately
          implemented and accepted. Silence is never treated as consent.
        </p>
      </div>

      {!connected ? (
        <DataSourceNotice status={status} title="publishing approvals" onRetry={onRefresh} />
      ) : approvals.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
          No publishing approval request exists in PostgreSQL. Requests are created by the pipeline,
          not by this console.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {approvals.map((approval) => {
            const awaiting =
              approval.status === "AWAITING_OWNER" || approval.status === "PENDING_NOTIFICATION";
            const checkEntries = approval.evaluatedChecks
              ? Object.entries(approval.evaluatedChecks)
              : [];

            return (
              <div
                key={approval.approvalId}
                className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold font-display text-[#E8EEF8] font-mono break-all">
                      {approval.approvalId}
                    </h2>
                    <p className="text-xs text-[#22D3EE] mt-0.5">
                      Director {approval.directorId || "unknown"}
                      {approval.packageId ? ` · package ${approval.packageId}` : ""}
                      {approval.universeId ? ` · universe ${approval.universeId}` : ""}
                    </p>
                    {approval.requestedAction && (
                      <p className="text-[11px] text-[#8D9AB3] mt-0.5">
                        Requested action: {approval.requestedAction}
                      </p>
                    )}
                  </div>
                  <StatusBadge label={approval.status} tone={toneFor(approval.status)} />
                </div>

                {awaiting && (
                  <div className="bg-[#101A2B] border border-[#FBBF24]/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 text-[#FBBF24] font-medium">
                      <Clock className="w-3.5 h-3.5" />
                      Owner Response Window (5h)
                    </span>
                    <span className="font-mono text-[#E8EEF8] tabular-nums">
                      {formatRemainingWindow(approval.deadlineAt, nowMs)}
                    </span>
                  </div>
                )}

                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 font-mono text-[11px] text-[#8D9AB3] break-all space-y-1">
                  <div className="text-[#34D399]">
                    Artifact SHA-256: {approval.artifactSha256 || "—"}
                  </div>
                  <div>Policy version: {approval.policyVersion || "—"}</div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Destinations</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {approval.destinations.length === 0 ? (
                        <span className="text-[#8D9AB3]">—</span>
                      ) : (
                        approval.destinations.map((destination) => (
                          <span
                            key={destination}
                            className="px-2 py-0.5 rounded border border-[#1E2A40] bg-[#101A2B] text-[11px] text-[#E8EEF8]"
                          >
                            {destination}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Deadline</div>
                    <p className="text-[#E8EEF8] mt-0.5 tabular-nums">
                      {formatTimestamp(approval.deadlineAt)}
                    </p>
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Requested</div>
                    <p className="text-[#E8EEF8] mt-0.5 tabular-nums">
                      {formatTimestamp(approval.createdAt)}
                    </p>
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Notified</div>
                    <p className="text-[#E8EEF8] mt-0.5 tabular-nums">
                      {formatTimestamp(approval.notifiedAt)}
                    </p>
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Owner response</div>
                    <p className="text-[#E8EEF8] mt-0.5 tabular-nums">
                      {formatTimestamp(approval.ownerResponseAt)}
                    </p>
                    {approval.ownerResponseReason && (
                      <p className="text-[11px] text-[#8D9AB3] mt-0.5">
                        {approval.ownerResponseReason}
                      </p>
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Authorization expires</div>
                    <p className="text-[#E8EEF8] mt-0.5 tabular-nums">
                      {formatTimestamp(approval.authorizationExpiresAt)}
                    </p>
                  </div>
                </div>

                {(approval.decisionSummary ||
                  approval.hermesDecision ||
                  approval.decisionReasonCodes.length > 0) && (
                  <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-lg p-3 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#22D3EE]">
                        HERMES Decision: {approval.hermesDecision ?? approval.status}
                      </span>
                      <span className="text-[11px] font-mono text-[#8D9AB3]">
                        Authorized: {approval.publishingAuthorized ? "YES" : "NO"}
                      </span>
                    </div>
                    {approval.decisionSummary && (
                      <p className="text-[#E8EEF8] leading-relaxed">{approval.decisionSummary}</p>
                    )}
                    <p className="text-[11px] text-[#8D9AB3] tabular-nums">
                      Decided: {formatTimestamp(approval.hermesDecidedAt)}
                    </p>
                    {approval.decisionReasonCodes.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {approval.decisionReasonCodes.map((code) => (
                          <span
                            key={code}
                            className="px-2 py-0.5 rounded bg-[#0D1420] border border-[#1E2A40] font-mono text-[10px] text-[#FBBF24]"
                          >
                            {code}
                          </span>
                        ))}
                      </div>
                    )}
                    {approval.decisionEvidenceHash && (
                      <p className="font-mono text-[10px] text-[#8D9AB3] break-all">
                        Decision evidence: {approval.decisionEvidenceHash}
                      </p>
                    )}
                  </div>
                )}

                {checkEntries.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-[#8D9AB3] uppercase tracking-wider">
                      HERMES 11-Check Verification Scorecard
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {checkEntries.map(([name, check]) => (
                        <div
                          key={name}
                          className="flex items-center justify-between gap-2 bg-[#101A2B] border border-[#1E2A40] rounded px-2.5 py-1.5 text-[11px]"
                        >
                          <span className="text-[#E8EEF8] truncate">{name}</span>
                          {check.passed ? (
                            <span className="text-[#34D399] font-semibold shrink-0">PASS</span>
                          ) : (
                            <span className="text-[#F87171] font-semibold shrink-0">
                              {check.reasonCode || "FAIL"}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs border-t border-[#1E2A40] pt-2.5">
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Owner notification</div>
                    {approval.notifications.length === 0 ? (
                      <p className="text-[#8D9AB3] mt-0.5">no notification rows</p>
                    ) : (
                      approval.notifications.map((notification, index) => (
                        <p
                          key={`${notification.kind}-${index}`}
                          className="text-[11px] text-[#E8EEF8] mt-0.5"
                        >
                          {notification.kind} · {notification.channel} ·{" "}
                          <span
                            className={
                              notification.state === "DELIVERED"
                                ? "text-[#34D399]"
                                : notification.state === "FAILED"
                                ? "text-[#F87171]"
                                : "text-[#FBBF24]"
                            }
                          >
                            {notification.state}
                          </span>{" "}
                          ({notification.attempts} attempt(s))
                        </p>
                      ))
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-[#8D9AB3]">Recorded decisions</div>
                    {approval.decisions.length === 0 ? (
                      <p className="text-[#8D9AB3] mt-0.5">none recorded</p>
                    ) : (
                      approval.decisions.map((decision, index) => (
                        <p
                          key={`${decision.actor}-${index}`}
                          className="text-[11px] text-[#E8EEF8] mt-0.5"
                        >
                          {decision.actor} · {decision.decision} ·{" "}
                          {formatTimestamp(decision.decidedAt)}
                        </p>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8D9AB3] border-t border-[#1E2A40] pt-2.5">
                  <span>
                    Publishing authorized:{" "}
                    <span
                      className={approval.publishingAuthorized ? "text-[#34D399]" : "text-[#FBBF24]"}
                    >
                      {approval.publishingAuthorized ? "yes" : "no"}
                    </span>
                  </span>
                  <span>
                    {checkEntries.length > 0
                      ? "11-check breakdown as returned by the API"
                      : "No 11-check breakdown returned by this API (none is invented)"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {connected && approvals.length > 0 && (
        <p className="text-xs text-[#8D9AB3]">
          {pending.length} request(s) currently awaiting a decision · {approvals.length} total.
        </p>
      )}
    </div>
  );
};
