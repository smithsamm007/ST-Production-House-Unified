import React from "react";
import type { Agent } from "../types/models";
import type { MemoryEntryDto } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { MEMORY_HIERARCHY, MEMORY_TYPES } from "../data/architectureBlueprint";
import { StatusBadge } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface MemoryScreenProps {
  agents: Agent[];
  entries: MemoryEntryDto[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  status: DataSourceStatus;
  onRefresh: () => void;
}

/**
 * Memory screen: durable per-Director memory categories plus the documented
 * M0–M6 isolation blueprint.
 *
 * The blueprint is explicitly labelled as documentation. Creative-charter prose
 * is NOT shown because it has no backend record — displaying seeded prose next
 * to a real Director id would misrepresent the Director's actual instructions.
 */
export const MemoryScreen: React.FC<MemoryScreenProps> = ({
  agents,
  entries,
  selectedAgentId,
  onSelectAgent,
  status,
  onRefresh,
}) => {
  const connected = status.state === "live" || status.state === "stale";

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Memory &amp; Lore"
        subtitle="Durable Director memory categories from PostgreSQL (M3 isolation), alongside the documented M0–M6 ownership model."
        status={status}
        onRefresh={onRefresh}
      />

      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
            M0–M6 Memory Ownership Hierarchy
          </h2>
          <StatusBadge label="Blueprint (design reference)" tone="warn" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5">
          {MEMORY_HIERARCHY.map((layer) => (
            <div
              key={layer.code}
              className={`rounded-lg border p-3 space-y-1 ${
                layer.code === "M3"
                  ? "bg-[#4F8CFF]/10 border-[#4F8CFF]/50"
                  : "bg-[#101A2B] border-[#1E2A40]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-bold text-[#22D3EE]">{layer.code}</span>
                <span className="text-[11px] font-mono text-[#8D9AB3]">{layer.isolation}</span>
              </div>
              <div className="text-xs font-semibold text-[#E8EEF8]">{layer.title}</div>
              <p className="text-[11px] text-[#8D9AB3] leading-relaxed">{layer.scope}</p>
            </div>
          ))}
        </div>

        <div className="pt-2 border-t border-[#1E2A40]">
          <div className="text-[11px] font-semibold text-[#8D9AB3] mb-1.5">
            Governed memory classifications
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MEMORY_TYPES.map((type) => (
              <span
                key={type}
                className="text-[11px] px-2.5 py-1 rounded-md bg-[#101A2B] border border-[#1E2A40] text-[#E8EEF8]"
              >
                {type}
              </span>
            ))}
          </div>
        </div>
      </section>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-[#8D9AB3]">Select Director</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {agents.slice(0, 24).map((agent) => {
            const selected = agent.id === selectedAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className={`px-3 py-2 rounded-lg border text-left transition-colors cursor-pointer ${
                  selected
                    ? "bg-[#4F8CFF]/15 border-[#4F8CFF]"
                    : "bg-[#0D1420] border-[#1E2A40] hover:border-[#2C3D5E]"
                }`}
              >
                <div
                  className={`text-xs font-semibold font-mono truncate ${
                    selected ? "text-[#22D3EE]" : "text-[#E8EEF8]"
                  }`}
                >
                  {agent.id}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {!connected ? (
        <DataSourceNotice status={status} title={`memory for ${selectedAgentId}`} onRetry={onRefresh} />
      ) : entries.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-center space-y-2">
          <p className="text-sm text-[#E8EEF8]">
            Director {selectedAgentId} has no persisted memory entries.
          </p>
          <p className="text-xs text-[#8D9AB3]">
            Memory is only written by Director workflows; this console does not seed it.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {entries.map((entry, index) => (
            <div
              key={entry.id ?? `${entry.category}-${index}`}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[#22D3EE] font-mono break-all">
                  {entry.category}
                </h3>
                <StatusBadge label="durable" tone="ok" />
              </div>
              <p className="text-sm text-[#E8EEF8] leading-relaxed whitespace-pre-wrap break-words">
                {entry.content}
              </p>
              <div className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                Updated: {entry.updatedAt ?? "not reported"}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-4 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="UNAVAILABLE" tone="bad" />
          <span className="text-sm font-bold text-[#E8EEF8]">Creative charter</span>
        </div>
        <p className="text-xs text-[#8D9AB3] leading-relaxed">
          Creative charters have no persistence route, so the console shows no charter prose for a real
          Director id. The Director creative-identity documents in docs/directors remain the current
          reference.
        </p>
      </div>
    </div>
  );
};
