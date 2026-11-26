import React, { useState } from "react";
import { Send } from "lucide-react";
import type { Agent, Channel, DirectorMessage, MessageKind } from "../types/models";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface CommunicationScreenProps {
  channels: Channel[];
  agents: Agent[];
  messages: DirectorMessage[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onSendMessage: (agentId: string, kind: MessageKind, body: string) => Promise<void>;
  status: DataSourceStatus;
  onRefresh: () => void;
  busy: boolean;
}

const MESSAGE_KINDS: MessageKind[] = ["conversation", "proposal", "instruction", "decision"];
const BACKEND_LIMIT = 4000;

const QUICK_TEMPLATES = [
  "Review episode pacing and tense climaxes",
  "Request 3 alternative visual keyframe styles",
  "Confirm the current production priority",
];

/**
 * Director Communication Studio.
 *
 * GET hydrates the durable conversation; POST routes the message through the
 * authenticated backend. There is no "send as Director" toggle any more: a
 * Director reply can only exist when the provider actually answered. When
 * Gemini is unconfigured the backend returns 503 PROVIDER_NOT_CONFIGURED and
 * that refusal is what the Owner sees.
 */
export const CommunicationScreen: React.FC<CommunicationScreenProps> = ({
  channels,
  agents,
  messages,
  selectedAgentId,
  onSelectAgent,
  onSendMessage,
  status,
  onRefresh,
  busy,
}) => {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MessageKind>("conversation");

  const filteredMessages = messages.filter((message) => message.agentId === selectedAgentId);
  const currentChannel = channels.find((channel) => channel.agentId === selectedAgentId);
  const connected = status.state === "live" || status.state === "stale";

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > BACKEND_LIMIT) return;
    await onSendMessage(selectedAgentId, kind, trimmed);
    setBody("");
  };

  const kindTone = (messageKind: MessageKind): StatusTone => {
    if (messageKind === "decision") return "ok";
    if (messageKind === "proposal") return "warn";
    return "info";
  };

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="Director Communication Studio"
        subtitle="Durable per-Director conversation, routed through the authenticated backend. A Director reply exists only when the configured provider actually answered."
        status={status}
        onRefresh={onRefresh}
        busy={busy}
      />

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
              <div className="text-[11px] text-[#8D9AB3] truncate">
                {channels.find((channel) => channel.agentId === agent.id)?.displayName ?? "no channel"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-lg px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-[#22D3EE]">
          Active: Director {selectedAgentId}
          {currentChannel ? ` (${currentChannel.displayName})` : ""}
        </span>
        <span className="text-[#8D9AB3]">
          Limit {BACKEND_LIMIT} chars/HTTP message · 30 messages/min per address
        </span>
      </div>

      {!connected ? (
        <DataSourceNotice
          status={status}
          title={`conversation with ${selectedAgentId}`}
          onRetry={onRefresh}
        />
      ) : (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3 min-h-[260px] max-h-[420px] overflow-y-auto">
          {filteredMessages.length === 0 ? (
            <div className="py-16 text-center text-xs text-[#8D9AB3]">
              No durable message exists for Director {selectedAgentId}.
            </div>
          ) : (
            filteredMessages.map((message) => {
              const isOwner = message.sender === "owner";
              return (
                <div
                  key={message.id}
                  className={`rounded-xl p-3.5 border space-y-1.5 ${
                    isOwner ? "bg-[#101A2B] border-[#1E2A40]" : "bg-[#0F1A2E] border-[#2C3D5E]"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-xs font-bold ${
                          isOwner
                            ? "text-[#E8EEF8]"
                            : message.source === "system_error"
                            ? "text-[#F87171]"
                            : "text-[#22D3EE]"
                        }`}
                      >
                        {isOwner ? "Owner" : `Director ${message.agentId}`}
                      </span>
                      <StatusBadge label={message.kind} tone={kindTone(message.kind)} />
                      {message.outcome && (
                        <StatusBadge
                          label={message.outcome}
                          tone={
                            message.outcome === "PROVIDER_UNAVAILABLE" ||
                            message.outcome === "ROUTING_FAILED"
                              ? "bad"
                              : message.outcome === "DIRECTOR_NEEDS_CLARIFICATION"
                              ? "warn"
                              : "ok"
                          }
                        />
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                      {message.timestamp}
                    </span>
                  </div>
                  <p className="text-sm text-[#E8EEF8] leading-relaxed whitespace-pre-wrap break-words">
                    {message.body}
                  </p>
                </div>
              );
            })
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {QUICK_TEMPLATES.map((template) => (
          <button
            key={template}
            type="button"
            onClick={() => {
              setBody(template);
              setKind("instruction");
            }}
            className="px-3 py-1.5 rounded-lg bg-[#101A2B] hover:bg-[#15233A] border border-[#1E2A40] text-xs text-[#E8EEF8] transition-colors cursor-pointer"
          >
            {template}
          </button>
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {MESSAGE_KINDS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors cursor-pointer ${
                  kind === option
                    ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                    : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-[#8D9AB3] tabular-nums">
            {body.length}/{BACKEND_LIMIT}
          </span>
        </div>

        <div className="flex items-end gap-2.5">
          <textarea
            rows={2}
            maxLength={BACKEND_LIMIT}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write to the Director…"
            className="flex-1 bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none resize-y"
          />
          <button
            type="submit"
            disabled={busy || body.trim().length === 0}
            className="h-11 px-4 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-50 text-[#070B12] font-bold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Send className="w-4 h-4" />
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
          Sending stores the Owner message durably and asks the Director provider for a reply. Without a
          configured provider the request fails honestly (503 PROVIDER_NOT_CONFIGURED) and no reply is
          written.
        </p>
      </form>
    </div>
  );
};
