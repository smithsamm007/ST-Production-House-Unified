import React, { useState } from "react";
import { Play, Plus, X } from "lucide-react";
import { Channel, ProductionRelease } from "../types/models";
import {
  PipelineStageStrip,
  StatusBadge,
  StatusTone,
} from "../components/StatusBadge";

interface ProductionScreenProps {
  channels: Channel[];
  releases: ProductionRelease[];
  onStartProduction: (
    channelId: string,
    title: string,
    season: number,
    episode: number
  ) => void;
  onAdvanceStage: (releaseId: string) => void;
}

export const ProductionScreen: React.FC<ProductionScreenProps> = ({
  channels,
  releases,
  onStartProduction,
  onAdvanceStage,
}) => {
  const [showDialog, setShowDialog] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState(
    channels[0]?.id ?? ""
  );
  const [title, setTitle] = useState("");
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !selectedChannelId) return;
    onStartProduction(selectedChannelId, title, season, episode);
    setShowDialog(false);
    setTitle("");
  };

  const getStatusTone = (status: string): StatusTone => {
    if (status === "in_production" || status === "rendering") return "warn";
    if (status === "published") return "ok";
    return "info";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            Production Pipeline Engine
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5">
            Orchestrate end-to-end media production through the 8 canonical
            stages with verified evidence generation.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowDialog(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Run
        </button>
      </div>

      <div className="space-y-4">
        {releases.map((rel) => (
          <div
            key={rel.id}
            className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold font-display text-[#E8EEF8]">
                  {rel.title}
                </h2>
                <p className="text-xs text-[#8D9AB3] mt-0.5 tabular-nums">
                  {rel.channelName} · S{rel.season} E{rel.episode}
                </p>
              </div>
              <StatusBadge
                label={rel.status.replace("_", " ")}
                tone={getStatusTone(rel.status)}
              />
            </div>

            <PipelineStageStrip currentStage={rel.currentStage} />

            <div className="w-full h-1.5 rounded-full bg-[#1E2A40] overflow-hidden">
              <div
                className="h-full bg-[#4F8CFF] rounded-full transition-all duration-200"
                style={{ width: `${Math.round(rel.stageProgress * 100)}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-[#8D9AB3] font-mono tabular-nums">
                Created: {rel.createdAt}
              </span>

              {rel.currentStage !== "complete" ? (
                <button
                  type="button"
                  onClick={() => onAdvanceStage(rel.id)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Execute Next Stage
                </button>
              ) : (
                <StatusBadge label="Production Certified" tone="ok" />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Launch New Production Release Modal */}
      {showDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-release-modal-title"
          onClick={() => setShowDialog(false)}
        >
          <form
            onSubmit={handleStart}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#0D1420] border border-[#2C3D5E] rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2
                id="new-release-modal-title"
                className="text-base font-bold font-display text-[#E8EEF8]"
              >
                Launch New Production Release
              </h2>
              <button
                type="button"
                onClick={() => setShowDialog(false)}
                className="p-1 rounded-lg text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs text-[#8D9AB3] mb-1.5">
                  Select Channel
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((ch) => {
                    const selected = selectedChannelId === ch.id;
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => setSelectedChannelId(ch.id)}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                          selected
                            ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                            : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]"
                        }`}
                      >
                        {ch.displayName}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Episode Title
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Episode title"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8D9AB3] mb-1">
                    Season
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={season}
                    onChange={(e) =>
                      setSeason(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-[#E8EEF8] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8D9AB3] mb-1">
                    Episode
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={episode}
                    onChange={(e) =>
                      setEpisode(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-[#E8EEF8] outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDialog(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold cursor-pointer"
              >
                Start Run
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
