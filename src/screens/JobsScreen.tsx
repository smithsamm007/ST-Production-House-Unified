import React from "react";
import type { MetricsDto } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { MetricCard, StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface JobsScreenProps {
  metrics: MetricsDto | null;
  status: DataSourceStatus;
}

const TONES: Record<string, StatusTone> = {
  running: "ok",
  queued: "info",
  succeeded: "ok",
  failed: "bad",
  waiting_for_quota: "warn",
  waiting_for_approval: "warn",
  paused: "warn",
};

/**
 * Job visibility, honestly limited.
 *
 * This repository mounts no job COLLECTION route, so the console shows the
 * aggregate counts that /api/metrics really returns and states the missing
 * capability instead of rendering a fabricated job list or fake controls.
 */
export const JobsScreen: React.FC<JobsScreenProps> = ({ metrics, status }) => {
  const connected = status.state === "live" || status.state === "stale";
  const jobsByStatus = metrics?.jobsByStatus ?? {};
  const entries = Object.entries(jobsByStatus).sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Production Jobs"
        subtitle="Aggregate queue state read from PostgreSQL through /api/metrics. Per-job rows and job controls are not exposed by this backend yet."
        status={status}
      />

      {!connected ? (
        <DataSourceNotice status={status} title="job counts" />
      ) : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Total jobs" value={total} tone="info" />
            <MetricCard
              label="Running"
              value={Number(jobsByStatus.running ?? 0)}
              tone="ok"
            />
            <MetricCard label="Queued" value={Number(jobsByStatus.queued ?? 0)} tone="info" />
            <MetricCard label="Failed" value={Number(jobsByStatus.failed ?? 0)} tone="bad" />
          </section>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">Counts by status</h2>
            {entries.length === 0 ? (
              <p className="text-xs text-[#8D9AB3]">The jobs table currently holds no rows.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {entries.map(([jobStatus, count]) => (
                  <span
                    key={jobStatus}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#1E2A40] bg-[#101A2B] text-[11px] text-[#E8EEF8]"
                  >
                    <StatusBadge label={jobStatus.replace(/_/g, " ")} tone={TONES[jobStatus] ?? "info"} />
                    <span className="font-mono tabular-nums">{count}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge label="UNAVAILABLE" tone="bad" />
              <h2 className="text-sm font-bold text-[#E8EEF8]">Job list &amp; job controls</h2>
            </div>
            <p className="text-xs text-[#8D9AB3] leading-relaxed">
              {status.detail ??
                "No GET /api/jobs collection route exists, and queue control lives behind /api/control/*, which this console does not use."}
            </p>
            <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
              Pause, resume and cancel are therefore not rendered: a button that cannot reach a real
              transition would be a simulated production action.
            </p>
          </section>
        </>
      )}
    </div>
  );
};
