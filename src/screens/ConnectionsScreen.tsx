import React from "react";
import type { Agent } from "../types/models";
import type { ConnectionView } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface ConnectionsScreenProps {
  agents: Agent[];
  connections: ConnectionView[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  status: DataSourceStatus;
  onRefresh: () => void;
  backendGap: string;
}

function toneFor(status: string): StatusTone {
  if (status === "connected" || status === "active") return "ok";
  if (status === "unconfigured" || status === "unverified") return "warn";
  return "info";
}

/**
 * Per-Director platform connections (GET /api/connections/directors/:agentId).
 *
 * Rule 16 isolation is enforced by the backend, which scopes every row to one
 * Owner and one Director and never serializes the secret locator. This screen
 * is read-only: connecting, replacing or revoking an account requires an OAuth
 * flow and a secret-manager locator, neither of which Day 2 may initiate.
 */
export const ConnectionsScreen: React.FC<ConnectionsScreenProps> = ({
  agents,
  connections,
  selectedAgentId,
  onSelectAgent,
  status,
  onRefresh,
  backendGap,
}) => {
  const connected = status.state === "live" || status.state === "stale";

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Platform Connections (Rule 16 &amp; 17)"
        subtitle="Each Director owns isolated connection slots. Only opaque locator metadata is readable here; no token value is ever serialized by the backend."
        status={status}
        onRefresh={onRefresh}
      />

      <div className="space-y-2">
        <div className="text-xs font-semibold text-[#8D9AB3]">Select Director</div>
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
              </button>
            );
          })}
        </div>
      </div>

      {!connected ? (
        <DataSourceNotice status={status} title={`connections for ${selectedAgentId}`} onRetry={onRefresh} />
      ) : connections.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-center space-y-2">
          <p className="text-sm text-[#E8EEF8]">
            No connection is configured for Director {selectedAgentId}.
          </p>
          <p className="text-xs text-[#8D9AB3]">
            That is the real backend answer — nothing is displayed in its place.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {connections.map((connection) => (
            <div
              key={connection.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-[#E8EEF8]">
                    {connection.label ?? connection.providerKey}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                    Director {connection.agentId} · {connection.kind || "kind not set"}
                  </p>
                </div>
                <StatusBadge label={connection.status} tone={toneFor(connection.status)} />
              </div>

              <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-0.5">
                <div className="text-[11px] font-semibold text-[#8D9AB3]">Provider key</div>
                <div className="text-xs font-mono text-[#34D399] break-all">
                  {connection.providerKey}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] text-[#8D9AB3] tabular-nums">
                <span>Connection id: {connection.id.slice(0, 8)}…</span>
                <span>Last verified: {connection.lastVerifiedAt ?? "never"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="UNAVAILABLE" tone="bad" />
          <h2 className="text-sm font-bold text-[#E8EEF8]">Connect / replace / revoke</h2>
        </div>
        <p className="text-xs text-[#8D9AB3] leading-relaxed">{backendGap}</p>
        <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
          Day 2 does not start OAuth flows, register provider apps or collect platform passwords. The
          Owner-only account policy is unchanged: no cross-Director sharing and no automatic fallback.
        </p>
      </div>
    </div>
  );
};
