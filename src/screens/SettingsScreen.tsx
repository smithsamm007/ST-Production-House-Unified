import React from "react";
import type { Owner, PublishingMode } from "../types/models";
import type { HealthDto, ReadyDto, SessionView } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { StatusBadge } from "../components/StatusBadge";
import { DataSourceBadge, DataSourceNotice } from "../components/DataSourceBadge";

interface SettingsScreenProps {
  owner: Owner;
  health: HealthDto | null;
  ready: ReadyDto | null;
  sessions: SessionView[];
  status: DataSourceStatus;
  defaultPublishingMode: PublishingMode;
  onPublishingModeChange: (mode: PublishingMode) => void;
  onLogout: () => Promise<void>;
  onRefresh: () => void;
  busy: boolean;
}

/**
 * Owner settings.
 *
 * Identity, storage engine, readiness and sessions are all backend facts. The
 * publishing mode is a LOCAL display preference and is labelled as such — it is
 * not a server policy and cannot authorize a publish.
 */
export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  owner,
  health,
  ready,
  sessions,
  status,
  defaultPublishingMode,
  onPublishingModeChange,
  onLogout,
  onRefresh,
  busy,
}) => (
  <div className="space-y-5 max-w-3xl">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Settings &amp; System Configuration
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Session, storage runtime and local display preferences.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DataSourceBadge status={status} />
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="px-2.5 py-1 rounded-md border border-[#2C3D5E] hover:border-[#4F8CFF] text-[11px] font-medium text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-50 cursor-pointer"
          >
            {busy ? "Refreshing…" : "Re-verify session"}
          </button>
        </div>
      </div>
    </div>

    <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5">
      <h2 className="text-sm font-bold font-display text-[#22D3EE]">Owner Identity (server-verified)</h2>
      <div className="space-y-2.5 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#8D9AB3]">Email</span>
          <span className="font-semibold text-[#E8EEF8] break-all">{owner.email}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#8D9AB3]">Owner id</span>
          <span className="font-mono text-xs text-[#E8EEF8] break-all">{owner.id}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#8D9AB3]">Role</span>
          <StatusBadge label={owner.role} tone={owner.role === "owner" ? "ok" : "warn"} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#8D9AB3]">Session</span>
          <StatusBadge label="authenticated (cookie + CSRF)" tone="ok" />
        </div>
      </div>
      <button
        type="button"
        onClick={() => void onLogout()}
        className="w-full py-2.5 px-4 rounded-lg bg-[#F87171]/15 hover:bg-[#F87171]/25 border border-[#F87171]/35 text-[#F87171] text-xs font-bold transition-colors cursor-pointer"
      >
        Sign Out of Owner Console
      </button>
      <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
        Sign out calls POST /api/auth/logout with the session CSRF token, so the server session is
        revoked rather than merely hidden.
      </p>
    </section>

    <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5">
      <h2 className="text-sm font-bold font-display text-[#22D3EE]">Storage &amp; Runtime</h2>
      {status.state === "live" || status.state === "stale" ? (
        <div className="space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Storage engine</span>
            <StatusBadge
              label={health?.storage ?? "unknown"}
              tone={health?.storage === "postgres" ? "ok" : "warn"}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Readiness</span>
            <StatusBadge
              label={`${ready?.status ?? health?.status ?? "unknown"}${
                ready?.database?.status ? ` · db ${ready.database.status}` : ""
              }`}
              tone={ready?.status === "ready" ? "ok" : "warn"}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Demo (non-durable) storage</span>
            <StatusBadge
              label={health?.isDemoStorage ? "active — NOT durable" : "not in use"}
              tone={health?.isDemoStorage ? "bad" : "ok"}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">OAuth secret manager</span>
            <StatusBadge
              label={
                health?.oauthSecretManager?.bound
                  ? health.oauthSecretManager.nonDurable
                    ? "bound · non-durable"
                    : "bound"
                  : "not configured"
              }
              tone={health?.oauthSecretManager?.bound ? "ok" : "warn"}
            />
          </div>
        </div>
      ) : (
        <DataSourceNotice status={status} title="runtime health" onRetry={onRefresh} />
      )}
    </section>

    <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">Active sessions</h2>
        <StatusBadge label={`${sessions.length} active`} tone="info" />
      </div>
      {sessions.length === 0 ? (
        <p className="text-xs text-[#8D9AB3]">The backend reported no active session rows.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-0.5"
            >
              <div className="text-xs font-mono text-[#E8EEF8] break-all">
                {session.id.slice(0, 8)}…
              </div>
              <div className="text-[11px] text-[#8D9AB3] tabular-nums">
                created {session.createdAt} · last seen {session.lastSeenAt} · assurance{" "}
                {session.mfaAssuranceLevel}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>

    <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">Publishing safety policy</h2>
        <StatusBadge label="Local display preference" tone="warn" />
      </div>
      <p className="text-xs text-[#8D9AB3] leading-relaxed">
        This preference is stored in this browser only. It does not authorize publishing: Rule 7 still
        requires an unexpired Owner approval bound to the exact artifact hash, destinations and caption,
        enforced by the backend.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { id: "dry_run", label: "Dry Run" },
            { id: "live", label: "Live" },
          ] as { id: PublishingMode; label: string }[]
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onPublishingModeChange(option.id)}
            className={`px-3.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
              defaultPublishingMode === option.id
                ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  </div>
);
