import React, { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Agent, Channel, MediaSlot } from "../types/models";
import { MediaSlotItem, StatusBadge } from "../components/StatusBadge";

interface DirectorsScreenProps {
  channels: Channel[];
  agents: Agent[];
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onAddChannel: (
    slug: string,
    displayName: string,
    tagline: string,
    language: string,
    agentId: string,
    launchTitle: string
  ) => void;
  onInspectSlot: (slot: MediaSlot, channelSlug: string) => void;
}

export const DirectorsScreen: React.FC<DirectorsScreenProps> = ({
  channels,
  agents,
  searchQuery,
  onSearchQueryChange,
  onAddChannel,
  onInspectSlot,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newTagline, setNewTagline] = useState("");
  const [newLanguage, setNewLanguage] = useState("Hindi / English");
  const [selectedAgentId, setSelectedAgentId] = useState(
    agents[0]?.id ?? "agent-01"
  );
  const [newLaunchTitle, setNewLaunchTitle] = useState("");

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        c.language.toLowerCase().includes(q)
    );
  }, [channels, searchQuery]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug.trim() || !newDisplayName.trim()) return;
    onAddChannel(
      newSlug,
      newDisplayName,
      newTagline,
      newLanguage,
      selectedAgentId,
      newLaunchTitle.trim() || `${newDisplayName.trim()} Pilot`
    );
    setShowModal(false);
    setNewSlug("");
    setNewDisplayName("");
    setNewTagline("");
    setNewLaunchTitle("");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            Director Channels
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5 tabular-nums">
            Public channel branding only. Internal director identities stay
            server-side (Rule 15). Registered: {agents.length}/50 cap.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Channel
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-[#8D9AB3] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Search channels by name, slug, language..."
          className="w-full bg-[#0D1420] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-xl pl-10 pr-4 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/70 outline-none transition-colors"
        />
      </div>

      {filteredChannels.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center space-y-3">
          <p className="text-sm text-[#8D9AB3]">
            No director channels match “{searchQuery}”.
          </p>
          <button
            type="button"
            onClick={() => onSearchQueryChange("")}
            className="px-3.5 py-1.5 rounded-lg border border-[#2C3D5E] text-xs font-medium text-[#22D3EE] hover:bg-[#101A2B] cursor-pointer"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {filteredChannels.map((channel) => (
            <div
              key={channel.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-[#E8EEF8] font-display">
                    {channel.displayName}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                    Director {channel.agentId} · {channel.language}
                  </p>
                </div>
                <StatusBadge label={channel.slug} tone="info" />
              </div>

              <p className="text-xs text-[#8D9AB3]">{channel.tagline}</p>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[#8D9AB3]">Platforms:</span>
                {channel.activePlatforms.map((plat, idx) => (
                  <React.Fragment key={plat}>
                    <span className="text-[#34D399] font-medium">{plat}</span>
                    {idx < channel.activePlatforms.length - 1 && (
                      <span aria-hidden="true" className="text-[#2C3D5E]">
                        ·
                      </span>
                    )}
                  </React.Fragment>
                ))}
              </div>

              <div className="border-t border-[#1E2A40] pt-3 space-y-2.5">
                <div className="text-xs font-medium text-[#8D9AB3]">
                  Canonical Media Slots (Rule 8: One standalone Reel
                  reservation)
                </div>
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
            </div>
          ))}
        </div>
      )}

      {/* Register New Channel Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-channel-title"
          onClick={() => setShowModal(false)}
        >
          <form
            onSubmit={handleCreate}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#0D1420] border border-[#2C3D5E] rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2
                id="new-channel-title"
                className="text-base font-bold font-display text-[#E8EEF8]"
              >
                Register New Channel
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1 rounded-lg text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Director Slot (Opaque ID — Rule 15)
                </label>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      Director {a.id}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Slug (e.g. sci-fi-chronicles)
                </label>
                <input
                  type="text"
                  required
                  value={newSlug}
                  onChange={(e) =>
                    setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                  }
                  placeholder="sci-fi-chronicles"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Cosmic Horizon Studios"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Tagline
                </label>
                <input
                  type="text"
                  value={newTagline}
                  onChange={(e) => setNewTagline(e.target.value)}
                  placeholder="Hard science fiction animated anthology"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Language
                </label>
                <input
                  type="text"
                  value={newLanguage}
                  onChange={(e) => setNewLanguage(e.target.value)}
                  placeholder="Hindi / English"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Launch Title / Pilot
                </label>
                <input
                  type="text"
                  value={newLaunchTitle}
                  onChange={(e) => setNewLaunchTitle(e.target.value)}
                  placeholder="Episode 1 — First Orbit"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold cursor-pointer"
              >
                Create Channel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
