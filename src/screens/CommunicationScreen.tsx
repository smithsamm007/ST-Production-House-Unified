import React, { useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import {
  Channel,
  DirectorMessage,
  MessageKind,
  MessageSender,
} from "../types/models";
import {
  DirectorChannelTabs,
  StatusBadge,
  StatusTone,
} from "../components/StatusBadge";

interface CommunicationScreenProps {
  channels: Channel[];
  messages: DirectorMessage[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onSendMessage: (
    agentId: string,
    kind: MessageKind,
    sender: MessageSender,
    body: string
  ) => void;
  onRefreshMessages?: (agentId: string) => void;
}

const MAX_DIRECTOR_COMM_CHARS = 4000;

const QUICK_TEMPLATES = [
  "Review episode pacing and tense climaxes",
  "Request 3 alternative visual keyframe styles",
  "Approve -14 LUFS soundscape master",
  "Enforce strict non-Euclidean continuity rule",
];

const MESSAGE_KINDS: MessageKind[] = [
  "conversation",
  "proposal",
  "instruction",
  "decision",
];

export const CommunicationScreen: React.FC<CommunicationScreenProps> = ({
  channels,
  messages,
  selectedAgentId,
  onSelectAgent,
  onSendMessage,
  onRefreshMessages,
}) => {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MessageKind>("conversation");

  const filteredMessages = messages.filter(
    (m) => m.agentId === selectedAgentId
  );
  const currentChannel = channels.find((c) => c.agentId === selectedAgentId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > MAX_DIRECTOR_COMM_CHARS) return;
    onSendMessage(selectedAgentId, kind, "owner", trimmed);
    setBody("");
  };

  const kindTone = (k: MessageKind): StatusTone => {
    if (k === "decision") return "ok";
    if (k === "proposal") return "warn";
    return "info";
  };

  const nearLimit = body.length >= 3600;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            Director Communication Studio
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5">
            Persistent Owner ↔ Director AI channel (4,000-char limit).
            Messages carry explicit semantics: conversation | proposal |
            instruction | decision. Never triggers unapproved publishing.
          </p>
        </div>

        {onRefreshMessages && (
          <button
            type="button"
            onClick={() => onRefreshMessages(selectedAgentId)}
            className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Sync History
          </button>
        )}
      </div>

      <DirectorChannelTabs
        channels={channels}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
      />

      {currentChannel && (
        <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-lg px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-[#22D3EE]">
            Active: Director {currentChannel.agentId} (
            {currentChannel.displayName})
          </span>
          <span className="text-[#8D9AB3]">
            Charter Language: {currentChannel.language}
          </span>
        </div>
      )}

      {/* Message Thread */}
      <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3 min-h-[280px] max-h-[420px] overflow-y-auto">
        {filteredMessages.length === 0 ? (
          <div className="py-16 text-center text-xs text-[#8D9AB3]">
            No messages recorded for Director {selectedAgentId} yet.
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const isOwner = msg.sender === "owner";
            return (
              <div
                key={msg.id}
                className={`rounded-xl p-3.5 border space-y-1.5 ${
                  isOwner
                    ? "bg-[#101A2B] border-[#1E2A40]"
                    : "bg-[#0F1A2E] border-[#2C3D5E]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-xs font-bold ${
                        isOwner
                          ? "text-[#E8EEF8]"
                          : msg.source === "system_error"
                          ? "text-[#F87171]"
                          : msg.source === "system_delivery_ack"
                          ? "text-[#FBBF24]"
                          : "text-[#22D3EE]"
                      }`}
                    >
                      {isOwner
                        ? "Owner (Console)"
                        : msg.source === "system_delivery_ack"
                        ? `System Ack · Director ${msg.agentId}`
                        : msg.source === "system_error"
                        ? `Provider Notice · Director ${msg.agentId}`
                        : `Director ${msg.agentId} (AI)`}
                    </span>
                    <StatusBadge label={msg.kind} tone={kindTone(msg.kind)} />
                    {msg.outcome && (
                      <StatusBadge
                        label={msg.outcome}
                        tone={
                          msg.outcome === "PROVIDER_UNAVAILABLE" ||
                          msg.outcome === "ROUTING_FAILED"
                            ? "bad"
                            : msg.outcome === "DIRECTOR_NEEDS_CLARIFICATION"
                            ? "warn"
                            : "ok"
                        }
                      />
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                    {msg.timestamp}
                  </span>
                </div>
                <p className="text-sm text-[#E8EEF8] leading-relaxed whitespace-pre-wrap">
                  {msg.body}
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Quick Templates */}
      <div className="flex flex-wrap gap-2">
        {QUICK_TEMPLATES.map((tpl) => (
          <button
            key={tpl}
            type="button"
            onClick={() => {
              setBody(tpl);
              setKind("instruction");
            }}
            className="px-3 py-1.5 rounded-lg bg-[#101A2B] hover:bg-[#15233A] border border-[#1E2A40] text-xs text-[#E8EEF8] transition-colors cursor-pointer"
          >
            {tpl}
          </button>
        ))}
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {MESSAGE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors cursor-pointer ${
                  kind === k
                    ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                    : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-[#8D9AB3]">Sender:</span>
            <span className="px-2.5 py-1 rounded-md bg-[#4F8CFF]/15 border border-[#4F8CFF]/40 text-[#22D3EE] text-xs font-medium">
              Owner (Authenticated)
            </span>
            <span
              className={`font-mono text-[11px] tabular-nums ml-2 ${
                nearLimit ? "text-[#FBBF24]" : "text-[#8D9AB3]"
              }`}
            >
              {body.length}/{MAX_DIRECTOR_COMM_CHARS}
            </span>
          </div>
        </div>

        <div className="flex items-end gap-2.5">
          <textarea
            rows={2}
            maxLength={MAX_DIRECTOR_COMM_CHARS}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Send creative brief, affiliate ad instruction, or feedback to the AI Director..."
            className="flex-1 bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none resize-y"
          />
          <button
            type="submit"
            disabled={!body.trim()}
            aria-label="Send message to Director"
            className="h-11 px-4 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-50 text-[#070B12] font-bold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </div>
      </form>
    </div>
  );
};
