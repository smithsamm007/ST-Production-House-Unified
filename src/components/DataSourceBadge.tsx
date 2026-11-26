import React from "react";
import type { DataSourceStatus, DataState } from "../types/dataState";
import { StatusBadge, StatusTone } from "./StatusBadge";

/**
 * Consistent data-source indicator.
 *
 * The badge is the console's honesty contract: it states where a screen's facts
 * came from and when they were last confirmed by the backend. A rendered page
 * alone never counts as a successful connection.
 */

const TONE_BY_STATE: Record<DataState, StatusTone> = {
  live: "ok",
  loading: "info",
  stale: "warn",
  offline: "bad",
  demo: "warn",
  unavailable: "bad",
  unauthorized: "bad",
  error: "bad",
};

const LABEL_BY_STATE: Record<DataState, string> = {
  live: "LIVE",
  loading: "LOADING",
  stale: "STALE",
  offline: "OFFLINE",
  demo: "DEMO",
  unavailable: "UNAVAILABLE",
  unauthorized: "UNAUTHORIZED",
  error: "ERROR",
};

const EXPLANATION_BY_STATE: Record<DataState, string> = {
  live: "Values below were returned by the authenticated backend.",
  loading: "A backend request is in progress; nothing is shown until it completes.",
  stale: "The last successful read is shown; the latest refresh failed.",
  offline: "The backend could not be reached. No values are shown.",
  demo: "Explicitly labelled demonstration content — not production state.",
  unavailable: "The backend capability required by this view does not exist.",
  unauthorized: "The Owner session is missing or expired.",
  error: "The backend returned an error.",
};

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface DataSourceBadgeProps {
  status: DataSourceStatus;
  /** Optional narrower label, e.g. "Directors". */
  scope?: string;
}

export const DataSourceBadge: React.FC<DataSourceBadgeProps> = ({ status, scope }) => {
  const stamp = formatTimestamp(status.lastUpdatedAt);
  const label = `${scope ? `${scope}: ` : ""}${LABEL_BY_STATE[status.state]}`;
  const suffix =
    status.state === "live" || status.state === "stale"
      ? stamp
        ? ` · ${stamp}`
        : ""
      : "";
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <StatusBadge label={`${label}${suffix}`} tone={TONE_BY_STATE[status.state]} />
      {status.state === "unauthorized" && (
        <span className="text-[11px] text-[#F87171]">Sign in to continue</span>
      )}
    </span>
  );
};

interface DataSourceNoticeProps {
  status: DataSourceStatus;
  /** Plain description of what the missing capability is. */
  title: string;
  onRetry?: () => void;
  children?: React.ReactNode;
}

/** Honest empty state for a domain whose data could not be loaded. */
export const DataSourceNotice: React.FC<DataSourceNoticeProps> = ({
  status,
  title,
  onRetry,
  children,
}) => {
  if (status.state === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-center space-y-2"
      >
        <div className="text-sm text-[#8D9AB3]">Loading {title.toLowerCase()}…</div>
        <div className="text-[11px] text-[#8D9AB3]/70">
          Waiting for the backend response; no cached values are displayed.
        </div>
      </div>
    );
  }

  const tone: StatusTone = TONE_BY_STATE[status.state];
  const borderClass =
    tone === "bad"
      ? "border-[#F87171]/35 bg-[#F87171]/5"
      : tone === "warn"
      ? "border-[#FBBF24]/35 bg-[#FBBF24]/5"
      : "border-[#1E2A40] bg-[#0D1420]";

  return (
    <div className={`rounded-xl border p-6 space-y-2.5 ${borderClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <DataSourceBadge status={status} scope={title} />
        <span className="text-sm font-semibold text-[#E8EEF8]">
          {LABEL_BY_STATE[status.state]} — {title}
        </span>
      </div>
      <p className="text-xs text-[#8D9AB3] leading-relaxed">
        {EXPLANATION_BY_STATE[status.state]}
      </p>
      {status.error && (
        <p className="text-xs text-[#F87171] leading-relaxed">{status.error}</p>
      )}
      {status.detail && (
        <p className="text-[11px] font-mono text-[#8D9AB3] break-all">{status.detail}</p>
      )}
      {children}
      {onRetry && status.state !== "unavailable" && status.state !== "unauthorized" && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 px-3.5 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] transition-colors cursor-pointer"
        >
          Retry read
        </button>
      )}
    </div>
  );
};

interface ScreenHeaderProps {
  title: string;
  subtitle: string;
  status: DataSourceStatus;
  onRefresh?: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}

/** Shared screen header that always carries the data-source badge. */
export const ScreenHeader: React.FC<ScreenHeaderProps> = ({
  title,
  subtitle,
  status,
  onRefresh,
  busy,
  children,
}) => (
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h1 className="text-lg font-bold font-display text-[#E8EEF8]">{title}</h1>
      <p className="text-xs text-[#8D9AB3] mt-0.5 max-w-3xl">{subtitle}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DataSourceBadge status={status} />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="px-2.5 py-1 rounded-md border border-[#2C3E50] hover:border-[#4F8CFF] text-[11px] font-medium text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-50 transition-colors cursor-pointer"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
    </div>
    {children}
  </div>
);
