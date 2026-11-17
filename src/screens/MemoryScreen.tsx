import React from "react";
import { Channel, CreativeCharter } from "../types/models";
import { MEMORY_HIERARCHY, MEMORY_TYPES } from "../data/architectureBlueprint";
import { DirectorChannelTabs, StatusBadge } from "../components/StatusBadge";

interface MemoryScreenProps {
  channels: Channel[];
  charters: Record<string, CreativeCharter>;
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}

export const MemoryScreen: React.FC<MemoryScreenProps> = ({
  channels,
  charters,
  selectedAgentId,
  onSelectAgent,
}) => {
  const currentCharter = charters[selectedAgentId];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Memory Architecture &amp; Director Creative Charter
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Memory is scoped across M0–M6 ownership layers. Director memory (M3) is
          isolated by default; sensitive credentials belong in the secret vault,
          never in AI memory.
        </p>
      </div>

      {/* M0–M6 Isolation Hierarchy */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
            M0–M6 Memory Ownership Hierarchy
          </h2>
          <StatusBadge label="Strict Tenant Isolation" tone="ok" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5">
          {MEMORY_HIERARCHY.map((layer) => {
            const isM3 = layer.code === "M3";
            return (
              <div
                key={layer.code}
                className={`rounded-lg border p-3 space-y-1 ${
                  isM3
                    ? "bg-[#4F8CFF]/10 border-[#4F8CFF]/50"
                    : "bg-[#101A2B] border-[#1E2A40]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold text-[#22D3EE]">
                    {layer.code}
                  </span>
                  <span className="text-[11px] font-mono text-[#8D9AB3]">
                    {layer.isolation}
                  </span>
                </div>
                <div className="text-xs font-semibold text-[#E8EEF8]">
                  {layer.title}
                </div>
                <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
                  {layer.scope}
                </p>
              </div>
            );
          })}
        </div>

        <div className="pt-2 border-t border-[#1E2A40]">
          <div className="text-[11px] font-semibold text-[#8D9AB3] mb-1.5">
            10 Governed Memory Classifications
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MEMORY_TYPES.map((mt) => (
              <span
                key={mt}
                className="text-[11px] px-2.5 py-1 rounded-md bg-[#101A2B] border border-[#1E2A40] text-[#E8EEF8]"
              >
                {mt}
              </span>
            ))}
          </div>
        </div>
      </section>

      <DirectorChannelTabs
        channels={channels}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
      />

      {currentCharter ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold font-display text-[#22D3EE]">
                M3 · Universe Creative Charter
              </h2>
              <StatusBadge
                label={`Director ${selectedAgentId} (Isolated)`}
                tone="info"
              />
            </div>

            <div className="space-y-4 divide-y divide-[#1E2A40]">
              <CharterField title="Logline" content={currentCharter.logline} />
              <CharterField
                title="Premise & Setting"
                content={currentCharter.premise}
                padded
              />
              <CharterField
                title="Visual Style & Palette"
                content={currentCharter.visualStyle}
                padded
              />
              <CharterField
                title="Pacing & Rhythm"
                content={currentCharter.pacing}
                padded
              />
              <CharterField
                title="Target Audience"
                content={currentCharter.targetAudience}
                padded
              />
            </div>
          </div>

          <div className="lg:col-span-2 bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3 h-fit">
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
              Character Continuity &amp; Non-Negotiable Rules
            </h2>
            <div className="space-y-2.5">
              {currentCharter.continuityRules.map((rule) => (
                <div
                  key={rule}
                  className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3 text-xs text-[#E8EEF8] leading-relaxed"
                >
                  {rule}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-center text-xs text-[#8D9AB3]">
          No creative charter registered for Director {selectedAgentId}.
        </div>
      )}
    </div>
  );
};

const CharterField: React.FC<{
  title: string;
  content: string;
  padded?: boolean;
}> = ({ title, content, padded }) => (
  <div className={padded ? "pt-3 space-y-1" : "space-y-1"}>
    <div className="text-[11px] font-semibold text-[#8D9AB3] tracking-wide">
      {title}
    </div>
    <p className="text-sm text-[#E8EEF8] leading-relaxed">{content}</p>
  </div>
);
