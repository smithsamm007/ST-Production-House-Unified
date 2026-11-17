import React from "react";
import { Channel, CreativeCharter } from "../types/models";
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
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Director Memory &amp; Creative Charter
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Universe rules, continuity guidelines, pacing parameters, and
          narrative lore for each production director.
        </p>
      </div>

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
                Universe Creative Charter
              </h2>
              <StatusBadge label={`Director ${selectedAgentId}`} tone="info" />
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
