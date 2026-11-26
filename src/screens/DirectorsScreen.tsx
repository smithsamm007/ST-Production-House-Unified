import React, { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import type { Agent, Channel } from "../types/models";
import type { DataSourceStatus } from "../types/dataState";
import { MetricCard, StatusBadge } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface DirectorsScreenProps {
  agents: Agent[];
  channels: Channel[];
  status: DataSourceStatus;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onAddChannel: (
    slug: string,
    displayName: string,
    tagline: string,
    language: string,
    agentId: string
  ) => Promise<void>;
  onRefresh: () => void;
  busy: boolean;
}

const PAGE_SIZE = 12;

type StatusFilter = "ALL" | "enabled" | "disabled";

/**
 * Durable Director registry (GET /api/agents) joined with public channel
 * branding (GET /api/channels).
 *
 * The list is bounded and paginated: at 50-Director scale the console must not
 * fetch and render everything unbounded. Media slots are NOT shown because the
 * backend exposes no slot data for them.
 */
export const DirectorsScreen: React.FC<DirectorsScreenProps> = ({
  agents,
  channels,
  status,
  searchQuery,
  onSearchQueryChange,
  onAddChannel,
  onRefresh,
  busy,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [channelFilter, setChannelFilter] = useState<"ALL" | "with" | "without">("ALL");
  const [page, setPage] = useState(0);
  const [newSlug, setNewSlug] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newTagline, setNewTagline] = useState("");
  const [newLanguage, setNewLanguage] = useState("Hindi / English");
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "agent-01");

  const channelByAgent = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) {
      if (!map.has(channel.agentId)) map.set(channel.agentId, channel);
    }
    return map;
  }, [channels]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return agents.filter((agent) => {
      const channel = channelByAgent.get(agent.id);
      if (statusFilter === "enabled" && !agent.enabled) return false;
      if (statusFilter === "disabled" && agent.enabled) return false;
      if (channelFilter === "with" && !channel) return false;
      if (channelFilter === "without" && channel) return false;
      if (!query) return true;
      return (
        agent.id.toLowerCase().includes(query) ||
        agent.name.toLowerCase().includes(query) ||
        agent.namespace.toLowerCase().includes(query) ||
        (channel?.displayName ?? "").toLowerCase().includes(query) ||
        (channel?.slug ?? "").toLowerCase().includes(query) ||
        (channel?.language ?? "").toLowerCase().includes(query)
      );
    });
  }, [agents, channelByAgent, searchQuery, statusFilter, channelFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const connected = status.state === "live" || status.state === "stale";

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newSlug.trim() || !newDisplayName.trim()) return;
    await onAddChannel(newSlug, newDisplayName, newTagline, newLanguage, selectedAgentId);
    setShowModal(false);
    setNewSlug("");
    setNewDisplayName("");
    setNewTagline("");
  };

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Director Registry"
        subtitle="Durable Director records from PostgreSQL. Internal Director names stay server-side (Rule 15); only opaque ids and public channel branding are shown."
        status={status}
        onRefresh={onRefresh}
        busy={busy}
      >
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Channel
        </button>
      </ScreenHeader>

      {!connected ? (
        <DataSourceNotice status={status} title="Director registry" onRetry={onRefresh} />
      ) : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Registry records" value={agents.length} tone="info" />
            <MetricCard
              label="Enabled"
              value={agents.filter((agent) => agent.enabled).length}
              tone="ok"
            />
            <MetricCard
              label="Disabled"
              value={agents.filter((agent) => !agent.enabled).length}
              tone="warn"
            />
            <MetricCard label="Channels" value={channels.length} tone="info" />
          </section>

          <div className="space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-[#8D9AB3] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => {
                  onSearchQueryChange(event.target.value);
                  setPage(0);
                }}
                placeholder="Search by Director id, namespace, channel name, slug or language…"
                className="w-full bg-[#0D1420] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-xl pl-10 pr-4 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/70 outline-none transition-colors"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(["ALL", "enabled", "disabled"] as StatusFilter[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setStatusFilter(option);
                    setPage(0);
                  }}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    statusFilter === option
                      ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {option === "ALL" ? "All records" : option}
                </button>
              ))}
              <span className="w-px h-6 bg-[#1E2A40] mx-1" aria-hidden="true" />
              {(["ALL", "with", "without"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setChannelFilter(option);
                    setPage(0);
                  }}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    channelFilter === option
                      ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {option === "ALL" ? "Any channel" : option === "with" ? "Has channel" : "No channel"}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
              No Director record matches these filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {visible.map((agent) => {
                const channel = channelByAgent.get(agent.id);
                return (
                  <div
                    key={agent.id}
                    className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="text-sm font-bold text-[#E8EEF8] font-mono truncate">
                          {agent.id}
                        </h2>
                        <p className="text-[11px] text-[#8D9AB3] font-mono truncate">
                          {agent.namespace || "namespace not set"}
                        </p>
                      </div>
                      <StatusBadge
                        label={agent.enabled ? "enabled" : "disabled"}
                        tone={agent.enabled ? "ok" : "warn"}
                      />
                    </div>

                    <div className="text-xs text-[#8D9AB3]">
                      {channel ? (
                        <span className="text-[#22D3EE] font-medium">
                          {channel.displayName}{" "}
                          <span className="text-[#8D9AB3] font-normal">
                            · {channel.slug} · {channel.language}
                          </span>
                        </span>
                      ) : (
                        "No public channel registered for this Director."
                      )}
                    </div>

                    <p className="text-[11px] text-[#8D9AB3] border-t border-[#1E2A40] pt-2 leading-relaxed">
                      Media slots, renders and evidence are per-release data; this record exposes none,
                      so none are displayed.
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8D9AB3]">
            <span className="tabular-nums">
              {filtered.length} matching record(s) · page {safePage + 1} of {pageCount}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] disabled:opacity-40 text-xs font-medium text-[#E8EEF8] cursor-pointer disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] disabled:opacity-40 text-xs font-medium text-[#E8EEF8] cursor-pointer disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

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
            onClick={(event) => event.stopPropagation()}
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

            <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
              POST /api/channels is an authenticated, CSRF-protected Owner mutation. The backend
              validates the slug, rejects duplicates with 409 and audits the write.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">
                  Director Slot (opaque id — Rule 15)
                </label>
                <select
                  value={selectedAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.id}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">Slug</label>
                <input
                  type="text"
                  required
                  value={newSlug}
                  onChange={(event) =>
                    setNewSlug(event.target.value.toLowerCase().replace(/\s+/g, "-"))
                  }
                  placeholder="sci-fi-chronicles"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">Display Name</label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(event) => setNewDisplayName(event.target.value)}
                  placeholder="Cosmic Horizon Studios"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">Tagline</label>
                <input
                  type="text"
                  value={newTagline}
                  onChange={(event) => setNewTagline(event.target.value)}
                  placeholder="Hard science fiction animated anthology"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm text-[#E8EEF8] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9AB3] mb-1">Language</label>
                <input
                  type="text"
                  value={newLanguage}
                  onChange={(event) => setNewLanguage(event.target.value)}
                  placeholder="Hindi / English"
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
                disabled={busy || agents.length === 0}
                className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-50 text-[#070B12] text-xs font-bold cursor-pointer"
              >
                {busy ? "Creating…" : "Create Channel"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
