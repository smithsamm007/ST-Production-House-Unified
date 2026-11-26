import React from "react";
import type { Agent, Channel, ProductionRelease, ScreenSection } from "../types/models";
import type { ApprovalCard, HealthDto, HermesOverviewDto, MetricsDto, ReadyDto } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { MetricCard, StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface OverviewScreenProps {
  metrics: MetricsDto | null;
  health: HealthDto | null;
  ready: ReadyDto | null;
  agents: Agent[];
  channels: Channel[];
  releases: ProductionRelease[];
  approvals: ApprovalCard[];
  hermesOverview: HermesOverviewDto | null;
  overviewStatus: DataSourceStatus;
  productionStatus: DataSourceStatus;
  approvalsStatus: DataSourceStatus;
  onNavigate: (section: ScreenSection) => void;
  onRefresh: () => void;
  busy: boolean;
}

const JOB_TONES: Record<string, StatusTone> = {
  running: "ok",
  queued: "info",
  succeeded: "ok",
  failed: "bad",
  waiting_for_quota: "warn",
  waiting_for_approval: "warn",
  paused: "warn",
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export const OverviewScreen: React.FC<OverviewScreenProps> = ({
  metrics,
  health,
  ready,
  agents,
  channels,
  releases,
  approvals,
  hermesOverview,
  overviewStatus,
  productionStatus,
  approvalsStatus,
  onNavigate,
  onRefresh,
  busy,
}) => {
  const connected = overviewStatus.state === "live" || overviewStatus.state === "stale";
  const enabledDirectors = agents.filter((agent) => agent.enabled).length;
  const disabledDirectors = agents.filter((agent) => !agent.enabled).length;
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "PENDING_OWNER" || approval.status === "pending"
  );
  const jobsByStatus = metrics?.jobsByStatus ?? {};
  const jobEntries = Object.entries(jobsByStatus).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Command Center"
        subtitle="Every value on this screen is read from the authenticated PostgreSQL-backed API. A missing capability is stated, never filled in."
        status={overviewStatus}
        onRefresh={onRefresh}
        busy={busy}
      />

      {!connected ? (
        <DataSourceNotice
          status={overviewStatus}
          title="overview metrics"
          onRetry={onRefresh}
        />
      ) : (
        <>
          <section aria-label="Operational metrics" className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {/* Counted from the records this screen already read. /api/metrics
                aggregates are authoritative on PostgreSQL, but the labelled
                demo adapter reports zero aggregates, and a false 0 next to a
                loaded collection would misrepresent the fleet. */}
            <MetricCard label="Registered Directors" value={agents.length} tone="info" />
            <MetricCard label="Channels" value={channels.length} tone="info" />
            <MetricCard label="Evidence Events" value={metrics?.evidenceEvents ?? 0} tone="ok" />
            <MetricCard label="Active Sessions" value={metrics?.activeSessions ?? 0} tone="info" />
            <MetricCard
              label="Blocked Refusals"
              value={hermesOverview?.blockedRefusals ?? 0}
              tone={(hermesOverview?.blockedRefusals ?? 0) > 0 ? "bad" : "ok"}
            />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Fleet Status</h2>
                <span className="text-[11px] text-[#8D9AB3] tabular-nums">
                  {agents.length} registry records
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3">
                  <div className="text-[11px] text-[#8D9AB3]">Enabled</div>
                  <div className="text-lg font-bold text-[#34D399] tabular-nums">{enabledDirectors}</div>
                </div>
                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3">
                  <div className="text-[11px] text-[#8D9AB3]">Disabled</div>
                  <div className="text-lg font-bold text-[#FBBF24] tabular-nums">{disabledDirectors}</div>
                </div>
                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3">
                  <div className="text-[11px] text-[#8D9AB3]">HERMES decisions</div>
                  <div className="text-lg font-bold text-[#22D3EE] tabular-nums">
                    {hermesOverview?.lastDecisionNumber ?? 0}
                  </div>
                </div>
                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3">
                  <div className="text-[11px] text-[#8D9AB3]">Pending approvals</div>
                  <div className="text-lg font-bold text-[#FBBF24] tabular-nums">
                    {hermesOverview?.pendingOwnerApproval ?? pendingApprovals.length}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onNavigate("directors")}
                  className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] cursor-pointer"
                >
                  Open Director registry
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("hermes")}
                  className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#22D3EE] cursor-pointer"
                >
                  HERMES decisions
                </button>
              </div>
            </div>

            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-2.5">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Control Plane</h2>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#8D9AB3]">Storage engine</span>
                  <StatusBadge
                    label={health?.storage ?? "unknown"}
                    tone={health?.storage === "postgres" ? "ok" : "warn"}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#8D9AB3]">Readiness</span>
                  <StatusBadge
                    label={ready?.status ?? health?.status ?? "unknown"}
                    tone={ready?.status === "ready" ? "ok" : "warn"}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#8D9AB3]">Demo storage</span>
                  <StatusBadge
                    label={health?.isDemoStorage ? "YES (non-durable)" : "no"}
                    tone={health?.isDemoStorage ? "bad" : "ok"}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#8D9AB3]">OAuth secret manager</span>
                  <StatusBadge
                    label={
                      health?.oauthSecretManager?.bound
                        ? health.oauthSecretManager.nonDurable
                          ? "bound (non-durable)"
                          : "bound"
                        : "not configured"
                    }
                    tone={health?.oauthSecretManager?.bound ? "ok" : "warn"}
                  />
                </div>
              </div>
              <p className="text-[11px] text-[#8D9AB3] leading-relaxed pt-1">
                Node {metrics?.process?.nodeVersion ?? "unknown"} · uptime{" "}
                {metrics?.process ? `${metrics.process.uptimeSeconds}s` : "unknown"} · RSS{" "}
                {metrics?.process ? `${metrics.process.memoryRssMb} MB` : "unknown"}
              </p>
            </div>
          </section>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Job Queue (counts only)</h2>
              <span className="text-[11px] text-[#8D9AB3]">
                Collection route unavailable — counts come from /api/metrics
              </span>
            </div>
            {jobEntries.length === 0 ? (
              <p className="text-xs text-[#8D9AB3]">The jobs table currently holds no rows.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {jobEntries.map(([status, count]) => (
                  <span
                    key={status}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#1E2A40] bg-[#101A2B] text-[11px] text-[#E8EEF8]"
                  >
                    <StatusBadge label={status} tone={JOB_TONES[status] ?? "info"} />
                    <span className="font-mono tabular-nums">{count}</span>
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Releases awaiting action</h2>
          <StatusBadge
            label={`production: ${productionStatus.state.toUpperCase()}`}
            tone={productionStatus.state === "live" ? "ok" : "warn"}
          />
        </div>
        {productionStatus.state !== "live" && productionStatus.state !== "stale" ? (
          <DataSourceNotice status={productionStatus} title="production releases" onRetry={onRefresh} />
        ) : releases.length === 0 ? (
          <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-6 text-xs text-[#8D9AB3]">
            No production releases exist yet in PostgreSQL. Start one from the Production screen.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {releases.slice(0, 6).map((release) => (
              <div
                key={release.id}
                className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-1.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-[#E8EEF8] truncate">{release.title}</h3>
                    <p className="text-xs text-[#8D9AB3] tabular-nums">
                      {release.channelName} · S{release.season} E{release.episode}
                    </p>
                  </div>
                  <StatusBadge
                    label={(release.backendStatus ?? release.status).replace(/_/g, " ")}
                    tone={
                      release.status === "published"
                        ? "ok"
                        : release.status === "cancelled"
                        ? "bad"
                        : "warn"
                    }
                  />
                </div>
                <p className="text-[11px] font-mono text-[#8D9AB3]">
                  Created {formatDateTime(release.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Owner approvals</h2>
          <StatusBadge
            label={`approvals: ${approvalsStatus.state.toUpperCase()}`}
            tone={approvalsStatus.state === "live" ? "ok" : "warn"}
          />
        </div>
        {approvalsStatus.state !== "live" && approvalsStatus.state !== "stale" ? (
          <DataSourceNotice status={approvalsStatus} title="publishing approvals" onRetry={onRefresh} />
        ) : (
          <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2">
            <p className="text-xs text-[#8D9AB3]">
              {pendingApprovals.length === 0
                ? "No approval request is awaiting the Owner."
                : `${pendingApprovals.length} request(s) are awaiting the Owner decision.`}
            </p>
            <button
              type="button"
              onClick={() => onNavigate("approvals")}
              className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] cursor-pointer"
            >
              Open Approval Center
            </button>
          </div>
        )}
      </section>

      <section className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1.5">
        <h2 className="text-sm font-bold text-[#22D3EE]">What this console never claims</h2>
        <ul className="text-xs text-[#8D9AB3] leading-relaxed list-disc list-inside space-y-1">
          <li>No Director media slot, provider latency, quota percentage or charter text is invented.</li>
          <li>No publishing success, platform ID or engagement count is displayed without a real receipt.</li>
          <li>Channels shown here are {channels.length} persisted records, not a catalog of 50.</li>
        </ul>
      </section>
    </div>
  );
};
