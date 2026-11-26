import React, { useState } from "react";
import { Play, Plus, X } from "lucide-react";
import type { Channel, ProductionRelease } from "../types/models";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface ProductionScreenProps {
  channels: Channel[];
  releases: ProductionRelease[];
  status: DataSourceStatus;
  onStartProduction: (
    channelId: string,
    title: string,
    season: number,
    episode: number
  ) => Promise<void>;
  onRunStage: (releaseId: string) => Promise<void>;
  onRefresh: () => void;
  busy: boolean;
}

function toneFor(status: string): StatusTone {
  if (status === "published") return "ok";
  if (status === "cancelled") return "bad";
  if (status === "review" || status === "rendering") return "warn";
  return "info";
}

/**
 * Production releases from GET /api/productions.
 *
 * The release DTO carries no pipeline-stage field, so this screen never claims
 * a stage or a percentage. Executing the next stage is a real POST that the
 * backend may refuse (queue admission, retirement, capability) — the refusal is
 * surfaced by the shared action-error banner.
 */
export const ProductionScreen: React.FC<ProductionScreenProps> = ({
  channels,
  releases,
  status,
  onStartProduction,
  onRunStage,
  onRefresh,
  busy,
}) => {
  const [showDialog, setShowDialog] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState(channels[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);

  const connected = status.state === "live" || status.state === "stale";
  const activeChannels = channels;

  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !selectedChannelId) return;
    await onStartProduction(selectedChannelId, title, season, episode);
    setShowDialog(false);
    setTitle("");
  };

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Production Releases"
        subtitle="Durable release records from PostgreSQL. Stage execution is a real backend mutation; nothing is advanced locally."
        status={status}
        onRefresh={onRefresh}
        busy={busy}
      >
        <button
          type="button"
          disabled={activeChannels.length === 0}
          onClick={() => setShowDialog(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-50 text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Release
        </button>
      </ScreenHeader>

      {!connected ? (
        <DataSourceNotice status={status} title="production releases" onRetry={onRefresh} />
      ) : releases.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
          No production releases exist in PostgreSQL yet.
        </div>
      ) : (
        <div className="space-y-3">
          {releases.map((release) => (
            <div
              key={release.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-bold font-display text-[#E8EEF8] truncate">
                    {release.title}
                  </h2>
                  <p className="text-xs text-[#8D9AB3] mt-0.5 tabular-nums">
                    {release.channelName} · S{release.season} E{release.episode}
                  </p>
                  <p className="text-[11px] font-mono text-[#8D9AB3] mt-1 break-all">
                    id: {release.id} · created {release.createdAt || "unknown"}
                  </p>
                </div>
                <StatusBadge
                  label={(release.backendStatus ?? release.status).replace(/_/g, " ")}
                  tone={toneFor(release.status)}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1E2A40] pt-2.5">
                <span className="text-[11px] text-[#8D9AB3]">
                  The release record exposes no pipeline stage, artifact hash or QC verdict, so none are
                  displayed. Run the pipeline to create them.
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onRunStage(release.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-60 text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Run pipeline stage
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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
            onClick={(event) => event.stopPropagation()}
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
                <div className="text-xs text-[#8D9AB3] mb-1.5">Select Channel</div>
                <div className="flex flex-wrap gap-1.5">
                  {activeChannels.map((channel) => {
                    const selected = selectedChannelId === channel.id;
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        onClick={() => setSelectedChannelId(channel.id)}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                          selected
                            ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                            : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]"
                        }`}
                      >
                        {channel.displayName}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">Episode Title</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Episode title"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8D9AB3] mb-1">Season</label>
                  <input
                    type="number"
                    min={1}
                    value={season}
                    onChange={(event) => setSeason(Math.max(1, Number(event.target.value) || 1))}
                    className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-[#E8EEF8] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8D9AB3] mb-1">Episode</label>
                  <input
                    type="number"
                    min={1}
                    value={episode}
                    onChange={(event) => setEpisode(Math.max(1, Number(event.target.value) || 1))}
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
                disabled={busy}
                className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-60 text-[#070B12] text-xs font-bold cursor-pointer"
              >
                {busy ? "Submitting…" : "Start Run"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
