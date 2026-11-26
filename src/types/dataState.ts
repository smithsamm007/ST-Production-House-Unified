/**
 * Explicit data-source states for the Owner Console.
 *
 * Every screen that shows production facts must say WHERE those facts come
 * from. A successful React render is not evidence of a backend connection, so
 * the state travels with the data instead of being inferred from the UI.
 *
 * - live         the real backend returned this data
 * - loading      a request is in flight and nothing older exists yet
 * - stale        an older successful read exists but the latest refresh failed
 * - offline      the network request never reached the backend
 * - demo         explicitly labelled demonstration/blueprint content
 * - unavailable  the backend capability does not exist (never faked)
 * - unauthorized the Owner session is missing or expired
 * - error        the backend returned an actual failure
 */
export type DataState =
  | "live"
  | "loading"
  | "stale"
  | "offline"
  | "demo"
  | "unavailable"
  | "unauthorized"
  | "error";

export interface DataSourceStatus {
  state: DataState;
  /** ISO timestamp of the last SUCCESSFUL read, or null when never read. */
  lastUpdatedAt: string | null;
  /** Machine/plain-language failure detail. Never contains secrets. */
  error: string | null;
  /** Extra honest context, e.g. why a capability is unavailable. */
  detail?: string | null;
}

export type DataDomain =
  | "session"
  | "settings"
  | "overview"
  | "directors"
  | "schedule"
  | "production"
  | "jobs"
  | "approvals"
  | "connections"
  | "providers"
  | "evidence"
  | "hermes"
  | "memory"
  | "communication";

export const DATA_DOMAINS: DataDomain[] = [
  "session",
  "settings",
  "overview",
  "directors",
  "schedule",
  "production",
  "jobs",
  "approvals",
  "connections",
  "providers",
  "evidence",
  "hermes",
  "memory",
  "communication",
];

export function pendingStatus(): DataSourceStatus {
  return { state: "loading", lastUpdatedAt: null, error: null };
}

export function initialSources(): Record<DataDomain, DataSourceStatus> {
  const sources = {} as Record<DataDomain, DataSourceStatus>;
  for (const domain of DATA_DOMAINS) sources[domain] = pendingStatus();
  return sources;
}
