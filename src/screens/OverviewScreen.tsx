import React from "react";
import { Play } from "lucide-react";
import {
  Channel,
  MediaSlot,
  OwnerAvailability,
  ProductionJob,
  ProductionRelease,
  ScreenSection,
} from "../types/models";
import {
  MediaSlotItem,
  MetricCard,
  PipelineStageStrip,
  StatusBadge,
  StatusTone,
} from "../components/StatusBadge";

interface OverviewScreenProps {
  channels: Channel[];
  releases: ProductionRelease[];
  jobs: ProductionJob[];
  agentCount: number;
  ownerAvailability: OwnerAvailability;
  onNavigate: (section: ScreenSection) => void;
  onAdvanceRelease: (releaseId: string) => void;
  onInspectSlot: (slot: MediaSlot, channelSlug: string) => void;
}

export const OverviewScreen: React.FC<OverviewScreenProps> = ({
  channels,
  releases,
  jobs,
  agentCount,
  ownerAvailability,
  onNavigate,
  onAdvanceRelease,
  onInspectSlot,
}) => {
  const activeJobsCount = jobs.filter(
    (j) => j.status === "running" || j.status === "queued"
  ).length;
  const succeededCount = jobs.filter((j) => j.status === "succeeded").length;
  const activeRelease = releases[0];

  const getReleaseTone = (status: string): StatusTone => {
    if (status === "in_production" || status === "rendering") return "warn";
    if (status === "published") return "ok";
    return "info";
  };

  return (
    <div className="space-y-6">
      {/* Supreme Governance Strip */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono font-bold text-[#22D3EE]">OWNER</span>
          <span className="text-[#2C3D5E]">→</span>
          <span className="text-[#E8EEF8] font-medium">
            Munder Difflin / Michael
          </span>
          <span className="text-[#2C3D5E]">→</span>
          <span className="text-[#22D3EE] font-semibold">HERMES</span>
          <span className="text-[#2C3D5E]">→</span>
          <span className="text-[#8D9AB3]">
            ST Production House · {agentCount} Independent Directors
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge
            label={
              ownerAvailability === "available"
                ? "Owner Available"
                : "Owner Unavailable · Delegation Active"
            }
            tone={ownerAvailability === "available" ? "ok" : "warn"}
          />
          <button
            type="button"
            onClick={() => onNavigate("hermes")}
            className="px-2.5 py-1 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] transition-colors whitespace-nowrap cursor-pointer"
          >
            Delegation
          </button>
          <button
            type="button"
            onClick={() => onNavigate("architecture")}
            className="px-2.5 py-1 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#22D3EE] transition-colors whitespace-nowrap cursor-pointer"
          >
            Blueprint
          </button>
        </div>
      </section>

      {/* Metrics Strip */}
      <section aria-label="Operational metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="Active Jobs"
          value={activeJobsCount}
          tone={activeJobsCount > 0 ? "warn" : "ok"}
        />
        <MetricCard label="Channels" value={channels.length} tone="info" />
        <MetricCard label="Directors" value={`${agentCount}/50`} tone="ok" />
        <MetricCard label="Completed" value={succeededCount} tone="ok" />
      </section>

      {/* The Production Pipeline */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
            The Production Pipeline
          </h2>
          {activeRelease && (
            <span className="text-xs text-[#8D9AB3]">
              Lead release:{" "}
              <span className="text-[#22D3EE] font-medium">
                {activeRelease.title}
              </span>
            </span>
          )}
        </div>
        <PipelineStageStrip
          currentStage={activeRelease?.currentStage ?? "story"}
        />
        <p className="text-xs text-[#8D9AB3]">
          Every director runs an independent production team. Stages map
          directly to durable pipeline events.
        </p>
      </section>

      {/* Active Production Releases */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
          Active Production Releases
        </h2>

        <div className="grid grid-cols-1 gap-3">
          {releases.map((release) => (
            <div
              key={release.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-[#E8EEF8]">
                    {release.title}
                  </h3>
                  <p className="text-xs text-[#8D9AB3] mt-0.5 tabular-nums">
                    {release.channelName} · S{release.season} E{release.episode}
                  </p>
                </div>
                <StatusBadge
                  label={release.status.replace("_", " ")}
                  tone={getReleaseTone(release.status)}
                />
              </div>

              <div className="w-full h-1.5 rounded-full bg-[#1E2A40] overflow-hidden">
                <div
                  className="h-full bg-[#4F8CFF] rounded-full transition-all duration-200"
                  style={{
                    width: `${Math.round(release.stageProgress * 100)}%`,
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-semibold text-[#22D3EE] font-mono tabular-nums">
                  Stage: {release.currentStage.toUpperCase()} (
                  {Math.round(release.stageProgress * 100)}%)
                </span>

                {release.currentStage !== "complete" && (
                  <button
                    type="button"
                    onClick={() => onAdvanceRelease(release.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#101A2B] hover:bg-[#16243D] border border-[#2C3D5E] text-[#22D3EE] text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Advance Stage
                  </button>
                )}
              </div>

              {release.executionLog.length > 0 && (
                <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-1">
                  <div className="text-[11px] font-semibold text-[#8D9AB3]">
                    Latest Stage Log
                  </div>
                  <div className="text-xs font-mono text-[#34D399]">
                    {release.executionLog[release.executionLog.length - 1]}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Director Channels & Canonical Media Slots */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
            Director Channels &amp; Canonical Media Slots
          </h2>
          <span className="text-xs text-[#8D9AB3]">
            Select any slot to inspect its deterministic checksum receipt
          </span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {channels.map((channel) => (
            <div
              key={channel.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-[#E8EEF8] font-display">
                    {channel.displayName}
                  </h3>
                  <div className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                    Director {channel.agentId} · {channel.language}
                  </div>
                </div>
                <StatusBadge label={channel.slug} tone="info" />
              </div>

              <p className="text-xs text-[#8D9AB3]">{channel.tagline}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {channel.slots.map((slot) => (
                  <MediaSlotItem
                    key={slot.key}
                    slot={slot}
                    onInspect={() => onInspectSlot(slot, channel.slug)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
