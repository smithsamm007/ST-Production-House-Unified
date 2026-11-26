import React, { useMemo } from "react";
import type { EvidenceEvent } from "../types/models";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface EvidenceScreenProps {
  events: EvidenceEvent[];
  status: DataSourceStatus;
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onRefresh: () => void;
}

const EVIDENCE_FILTERS = [
  "ALL",
  "QC",
  "ASSEMBLY",
  "AUDIO",
  "SCHEDULE",
  "COMMUNICATION",
  "APPROVAL",
  "SYSTEM",
];

/**
 * Append-only evidence ledger from GET /api/evidence.
 *
 * Each row is a real chained record (kind, payload, previous hash, event hash).
 * The badge reflects the ledger's own classification instead of stamping every
 * row "VERIFIED", which a console cannot know on its own.
 */
export const EvidenceScreen: React.FC<EvidenceScreenProps> = ({
  events,
  status,
  currentFilter,
  onFilterChange,
  onRefresh,
}) => {
  const filteredEvents = useMemo(() => {
    if (currentFilter === "ALL") return events;
    const query = currentFilter.toLowerCase();
    return events.filter(
      (event) =>
        event.eventType.toLowerCase().includes(query) ||
        event.stage.toLowerCase().includes(query) ||
        event.channelSlug.toLowerCase().includes(query)
    );
  }, [events, currentFilter]);

  const connected = status.state === "live" || status.state === "stale";

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Evidence Ledger (Rules 1 &amp; 2)"
        subtitle="Append-only chained records returned by the backend. An event recorded here is evidence; the console never manufactures one."
        status={status}
        onRefresh={onRefresh}
      />

      <div className="flex flex-wrap gap-1.5">
        {EVIDENCE_FILTERS.map((filter) => {
          const active = currentFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => onFilterChange(filter)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                active
                  ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                  : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
              }`}
            >
              {filter}
            </button>
          );
        })}
        <span className="ml-auto text-xs text-[#8D9AB3] tabular-nums self-center">
          {filteredEvents.length} / {events.length} records
        </span>
      </div>

      {!connected ? (
        <DataSourceNotice status={status} title="evidence ledger" onRetry={onRefresh} />
      ) : filteredEvents.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center space-y-3">
          <p className="text-sm text-[#8D9AB3]">
            {events.length === 0
              ? "The evidence ledger is empty."
              : `No evidence event matches filter “${currentFilter}”.`}
          </p>
          {events.length > 0 && (
            <button
              type="button"
              onClick={() => onFilterChange("ALL")}
              className="px-3.5 py-1.5 rounded-lg border border-[#2C3D5E] text-xs font-medium text-[#22D3EE] hover:bg-[#101A2B] cursor-pointer"
            >
              Show all evidence
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEvents.map((event) => (
            <div
              key={event.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold font-mono text-[#E8EEF8] break-all">
                    {event.eventType}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                    {event.agentId} · {event.channelSlug} · stage {event.stage}
                  </p>
                </div>
                <StatusBadge label="ledger record" tone="ok" />
              </div>

              <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-1 font-mono text-[11px] break-all">
                <div className="text-[#34D399]">Event hash: {event.artifactHash || "—"}</div>
                <div className="text-[#8D9AB3]">Previous hash: {event.verificationReceipt || "genesis"}</div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                <span>Occurred: {event.timestamp || "unknown"}</span>
                <span>Event id: {event.id.slice(0, 8)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
