import React from "react";
import { Lock, ShieldAlert } from "lucide-react";
import type { HermesDecision } from "../types/models";
import type { HermesOverviewDto } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { MetricCard, StatusBadge } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface HermesScreenProps {
  overview: HermesOverviewDto | null;
  decisions: HermesDecision[];
  status: DataSourceStatus;
  onRefresh: () => void;
  availabilityGap: string;
  delegationGap: string;
}

/**
 * HERMES decision layer (GET /api/hermes/overview + /api/hermes/decisions).
 *
 * Real durable decisions only. The previous interactive "evaluate delegation"
 * simulator and the availability/delegation toggles are gone: they mutated
 * browser state that no backend had, which made governance look decided when
 * nothing had been recorded.
 */
export const HermesScreen: React.FC<HermesScreenProps> = ({
  overview,
  decisions,
  status,
  onRefresh,
  availabilityGap,
  delegationGap,
}) => {
  const connected = status.state === "live" || status.state === "stale";
  const outcomeEntries = Object.entries(overview?.decisions ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="HERMES · Managing Director"
        subtitle="Durable, auditable decision records. HERMES holds decision authority without provider secrets; every refusal and approval requirement is persisted."
        status={status}
        onRefresh={onRefresh}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-bold font-display text-[#22D3EE]">
            Authority Matrix &amp; Boundaries
          </h2>
          <ul className="space-y-1.5 text-xs text-[#E8EEF8]">
            <li>
              <span className="font-semibold text-[#34D399]">Tier 1 (Autonomous):</span> provider
              routing, bounded retry recovery, cache hits, emergency local-slot fallback.
            </li>
            <li>
              <span className="font-semibold text-[#22D3EE]">Tier 2 (Policy Governed):</span>{" "}
              production queue balancing, capacity, quality refusal, budget ceilings.
            </li>
            <li>
              <span className="font-semibold text-[#FBBF24]">
                Tier 3 (Owner Required / Explicit Delegation):
              </span>{" "}
              live social publishing, new paid spend, OAuth credential bindings, security rules,
              deletions.
            </li>
          </ul>
        </div>

        <div className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-[#FBBF24] uppercase tracking-wider">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            No Assumed Consent
          </div>
          <p className="text-xs text-[#E8EEF8] leading-relaxed">
            No response is not consent. An expired approval activates a delegated action only when that
            exact decision type was explicitly delegated — never an Owner-only boundary.
          </p>
          <div className="pt-1.5 space-y-1">
            <StatusBadge label="Owner availability: UNAVAILABLE" tone="bad" />
            <p className="text-[11px] text-[#8D9AB3] leading-relaxed">{availabilityGap}</p>
          </div>
        </div>
      </section>

      {!connected ? (
        <DataSourceNotice status={status} title="HERMES decisions" onRetry={onRefresh} />
      ) : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Last decision #" value={overview?.lastDecisionNumber ?? 0} tone="info" />
            <MetricCard label="Blocked refusals" value={overview?.blockedRefusals ?? 0} tone="bad" />
            <MetricCard
              label="Awaiting Owner"
              value={overview?.pendingOwnerApproval ?? 0}
              tone="warn"
            />
            <MetricCard label="Decision records" value={decisions.length} tone="ok" />
          </section>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Outcomes by state</h2>
            {outcomeEntries.length === 0 ? (
              <p className="text-xs text-[#8D9AB3]">No HERMES decision has been recorded yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {outcomeEntries.map(([outcome, count]) => (
                  <span
                    key={outcome}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#1E2A40] bg-[#101A2B] text-[11px] text-[#E8EEF8]"
                  >
                    <StatusBadge
                      label={outcome}
                      tone={
                        outcome === "BLOCKED"
                          ? "bad"
                          : outcome === "OWNER_APPROVAL_REQUIRED"
                          ? "warn"
                          : "ok"
                      }
                    />
                    <span className="font-mono tabular-nums">{count}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Lock className="w-3.5 h-3.5 text-[#F87171]" />
              <h2 className="text-sm font-bold text-[#E8EEF8]">Delegation matrix</h2>
              <StatusBadge label="UNAVAILABLE" tone="bad" />
            </div>
            <p className="text-xs text-[#8D9AB3] leading-relaxed">{delegationGap}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#8D9AB3]">
              Recent decisions
            </h2>
            {decisions.length === 0 ? (
              <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-center text-xs text-[#8D9AB3]">
                No decision records returned by the backend.
              </div>
            ) : (
              <div className="space-y-3">
                {decisions.map((decision) => (
                  <div
                    key={decision.id}
                    className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-[#E8EEF8] break-all">{decision.topic}</h3>
                      <StatusBadge label={decision.authorityTier} tone="info" />
                    </div>
                    <div className="text-xs font-semibold text-[#34D399] break-all">
                      {decision.decision}
                    </div>
                    <p className="text-xs text-[#8D9AB3] break-words">Reason: {decision.rationale}</p>
                    <div className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                      {decision.timestamp || "timestamp unavailable"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
