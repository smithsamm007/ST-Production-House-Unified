import React, { useMemo } from "react";
import { EvidenceEvent } from "../types/models";
import { StatusBadge } from "../components/StatusBadge";

interface EvidenceScreenProps {
  events: EvidenceEvent[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
}

const EVIDENCE_FILTERS = [
  "ALL",
  "QC",
  "ASSEMBLY",
  "AUDIO",
  "SCHEDULE",
  "COMMUNICATION",
  "APPROVAL",
];

export const EvidenceScreen: React.FC<EvidenceScreenProps> = ({
  events,
  currentFilter,
  onFilterChange,
}) => {
  const filteredEvents = useMemo(() => {
    if (currentFilter === "ALL") return events;
    const q = currentFilter.toLowerCase();
    return events.filter(
      (ev) =>
        ev.eventType.toLowerCase().includes(q) ||
        ev.stage.toLowerCase().includes(q)
    );
  }, [events, currentFilter]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Durable Evidence Ledger (Rules 1 &amp; 2)
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Never claim an execution occurred without durable evidence. Zero fake
          receipts or mock platform IDs. Filterable cryptographic audit trail.
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-1.5">
        {EVIDENCE_FILTERS.map((f) => {
          const active = currentFilter === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => onFilterChange(f)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                active
                  ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                  : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
              }`}
            >
              {f}
            </button>
          );
        })}
      </div>

      {filteredEvents.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center space-y-3">
          <p className="text-sm text-[#8D9AB3]">
            No evidence events matching filter “{currentFilter}”.
          </p>
          <button
            type="button"
            onClick={() => onFilterChange("ALL")}
            className="px-3.5 py-1.5 rounded-lg border border-[#2C3D5E] text-xs font-medium text-[#22D3EE] hover:bg-[#101A2B] cursor-pointer"
          >
            Show all evidence
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEvents.map((ev) => (
            <div
              key={ev.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold font-mono text-[#E8EEF8]">
                    {ev.eventType}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                    Director {ev.agentId} · {ev.channelSlug} · Stage:{" "}
                    {ev.stage.toUpperCase()}
                  </p>
                </div>
                <StatusBadge label="VERIFIED" tone="ok" />
              </div>

              <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-1 font-mono text-[11px] break-all">
                <div className="text-[#34D399]">
                  Receipt: {ev.verificationReceipt}
                </div>
                <div className="text-[#8D9AB3]">Hash: {ev.artifactHash}</div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                <span>Timestamp: {ev.timestamp}</span>
                <span>Event ID: {ev.id.slice(0, 8)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
