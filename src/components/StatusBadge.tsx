import React from "react";
import { Search } from "lucide-react";
import { Channel, MediaSlot, PIPELINE_STAGES } from "../types/models";
import { formatDuration } from "../utils/crypto";

export type StatusTone = "ok" | "warn" | "bad" | "info";

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  label,
  tone = "info",
}) => {
  const toneClasses: Record<StatusTone, string> = {
    ok: "text-[#34D399] border-[#34D399]/35 bg-[#34D399]/10",
    warn: "text-[#FBBF24] border-[#FBBF24]/35 bg-[#FBBF24]/10",
    bad: "text-[#F87171] border-[#F87171]/35 bg-[#F87171]/10",
    info: "text-[#22D3EE] border-[#22D3EE]/35 bg-[#22D3EE]/10",
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap shrink-0 ${toneClasses[tone]}`}
    >
      {label}
    </span>
  );
};

interface MetricCardProps {
  label: string;
  value: string | number;
  tone?: StatusTone;
  subtext?: string;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  tone = "ok",
  subtext,
}) => {
  const valueColors: Record<StatusTone, string> = {
    ok: "text-[#34D399]",
    warn: "text-[#FBBF24]",
    bad: "text-[#F87171]",
    info: "text-[#22D3EE]",
  };

  return (
    <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl px-4 py-3.5 flex flex-col justify-between">
      <span className="text-xs font-medium text-[#8D9AB3] tracking-wide">
        {label}
      </span>
      <div
        className={`text-2xl font-bold font-display tabular-nums mt-1 ${valueColors[tone]}`}
      >
        {value}
      </div>
      {subtext ? (
        <span className="text-[11px] text-[#8D9AB3] mt-1">{subtext}</span>
      ) : null}
    </div>
  );
};

interface PipelineStageStripProps {
  currentStage: string;
  compact?: boolean;
}

export const PipelineStageStrip: React.FC<PipelineStageStripProps> = ({
  currentStage,
  compact = false,
}) => {
  // An empty stage means the backend does not report one; no stage is marked
  // current rather than defaulting to "story" and implying progress.
  const currentIdx = PIPELINE_STAGES.findIndex((s) => s.key === currentStage);

  return (
    <div className="w-full overflow-x-auto pb-1">
      <div className="flex items-center gap-1.5 min-w-max">
        {PIPELINE_STAGES.map((stage, index) => {
          const isCompleted = currentIdx >= 0 && index < currentIdx;
          const isCurrent = currentIdx >= 0 && index === currentIdx;

          const containerClass = isCurrent
            ? "bg-[#4F8CFF]/15 border-[#4F8CFF] text-[#22D3EE]"
            : isCompleted
            ? "bg-[#34D399]/10 border-[#34D399]/40 text-[#34D399]"
            : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]";

          return (
            <React.Fragment key={stage.key}>
              <div
                className={`rounded-lg border px-2.5 py-1.5 transition-colors ${containerClass} ${
                  compact ? "min-w-[84px]" : "min-w-[96px]"
                }`}
              >
                <div className="text-xs font-semibold tabular-nums whitespace-nowrap">
                  {index + 1}. {stage.key}
                </div>
                <div className="text-[11px] text-[#8D9AB3] whitespace-nowrap">
                  {stage.label}
                </div>
              </div>
              {index < PIPELINE_STAGES.length - 1 && (
                <span
                  aria-hidden="true"
                  className="text-xs text-[#2C3D5E] select-none px-0.5"
                >
                  →
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

interface MediaSlotItemProps {
  slot: MediaSlot;
  onInspect: () => void;
}

export const MediaSlotItem: React.FC<MediaSlotItemProps> = ({
  slot,
  onInspect,
}) => {
  const tone: StatusTone =
    slot.status === "verified" || slot.status === "published"
      ? "ok"
      : slot.status === "rendering"
      ? "warn"
      : "info";

  return (
    <button
      type="button"
      onClick={onInspect}
      className="w-full text-left bg-[#101A2B] hover:bg-[#132036] border border-[#1E2A40] hover:border-[#2C3D5E] rounded-lg p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4F8CFF] group cursor-pointer"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-[#E8EEF8] truncate">
            {slot.label}
          </span>
          <span className="text-[11px] text-[#8D9AB3] tabular-nums shrink-0">
            ({slot.aspectRatio})
          </span>
        </div>
        <StatusBadge label={slot.status} tone={tone} />
      </div>

      {slot.artifactTitle && (
        <div className="text-xs text-[#22D3EE] font-medium truncate mt-1.5">
          {slot.artifactTitle}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mt-1.5 text-[11px] text-[#8D9AB3]">
        <span className="truncate">
          {slot.hint} · {slot.resolution}
        </span>
        {slot.durationSeconds != null && (
          <span className="font-mono tabular-nums shrink-0">
            {formatDuration(slot.durationSeconds)}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-[#1E2A40]/70">
        <span className="text-[10.5px] font-mono text-[#8D9AB3] tabular-nums truncate">
          {slot.artifactHash
            ? `SHA: ${slot.artifactHash.slice(0, 16)}…`
            : "Unrendered plan slot"}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#22D3EE] group-hover:text-[#E8EEF8] transition-colors whitespace-nowrap shrink-0">
          <Search className="w-3 h-3" />
          Inspect
        </span>
      </div>
    </button>
  );
};

interface DirectorChannelTabsProps {
  channels: Channel[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}

export const DirectorChannelTabs: React.FC<DirectorChannelTabsProps> = ({
  channels,
  selectedAgentId,
  onSelectAgent,
}) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {channels.map((ch) => {
        const isSelected = ch.agentId === selectedAgentId;
        return (
          <button
            key={ch.id}
            type="button"
            onClick={() => onSelectAgent(ch.agentId)}
            className={`px-3 py-2.5 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4F8CFF] cursor-pointer ${
              isSelected
                ? "bg-[#4F8CFF]/15 border-[#4F8CFF]"
                : "bg-[#0D1420] border-[#1E2A40] hover:border-[#2C3D5E]"
            }`}
          >
            <div
              className={`text-xs font-semibold truncate ${
                isSelected ? "text-[#22D3EE]" : "text-[#E8EEF8]"
              }`}
            >
              {ch.displayName}
            </div>
            <div className="text-[11px] font-mono text-[#8D9AB3] mt-0.5 tabular-nums">
              Director {ch.agentId}
            </div>
          </button>
        );
      })}
    </div>
  );
};
