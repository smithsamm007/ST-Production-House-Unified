import { OwnerApiClient, ApiError } from "../api/client";
import React, { useCallback, useEffect, useState } from "react";

/**
 * Owner notification inbox & daily FORGE report console.
 *
 * This screen is backed by the durable API only (`/api/notifications`,
 * `/api/forge-reports`). It never invents an event, a delivery outcome or a
 * report: when the API is unavailable the panel says so, and an outbox row is
 * shown with its real per-channel delivery state (delivered / retry_scheduled /
 * dead_letter / unconfigured).
 */

interface DeliveryState {
  channel: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  errorClass: string | null;
  deliveryFailed: boolean;
}

interface InboxEvent {
  id: string;
  eventType: string;
  priority: "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
  taskRef: string | null;
  directorId: string | null;
  createdAt: string;
  readAt: string | null;
  unread: boolean;
  payload: Record<string, unknown>;
  deliveries: DeliveryState[];
}

interface ChannelState {
  channel: string;
  transport: string | null;
  configured: boolean;
  runtimeConfigured: boolean;
  ownerEnabled: boolean;
  requiredSecretName: string | null;
  statusReason: string | null;
  immutable: boolean;
}

interface ReportSummary {
  reportId: string;
  reportDate: string;
  status: string;
  evidenceHash: string | null;
  generatedAt: string | null;
  generationAttempts: number;
  failedReason: string | null;
  notificationEventId: string | null;
}

interface ReportDetail extends ReportSummary {
  executiveSummary: {
    overallCondition: string;
    whatChanged: string[];
    remainsBlocked: string[];
    productionActivity: boolean;
    productionActivityDetail: string;
  } | null;
  sections: Record<string, unknown> | null;
  claims: Array<{ claimId: string; statement: string; verification: string }>;
  evidenceRefs: Array<{ kind: string; table?: string }>;
  payloadHashVerified: boolean;
  accuracyLegend: Record<string, string> | null;
}

interface ScheduleState {
  enabled: boolean;
  timezone: string;
  localTime: string;
  localHour: number;
  localMinute: number;
  missedRunPolicy: string;
  lastRunAt: string | null;
  lastReportDate: string | null;
  nextRunAt: string | null;
}

interface DeadLetter {
  id: string;
  channel: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  deadLetteredAt: string | null;
  errorClass: string | null;
  eventType: string | null;
  priority: string | null;
}

/** Inbox & reports use the SHARED Owner Console API client. */
const inboxClient = new OwnerApiClient();

async function ensureCsrf(): Promise<void> {
  if (inboxClient.csrfToken) return;
  try {
    const me = await inboxClient.get("/api/auth/me");
    inboxClient.setCsrfToken(me?.csrfToken ?? null);
  } catch {
    // The mutation below fails honestly with its own status code.
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  try {
    if (method === "GET") return (await inboxClient.get(path)) as T;
    await ensureCsrf();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return (await inboxClient.request(path, { method, body })) as T;
  } catch (error) {
    const apiError = error as ApiError;
    throw new Error(apiError?.code ?? `HTTP_${apiError?.status ?? 0}`);
  }
}

const PRIORITY_CLASS: Record<string, string> = {
  CRITICAL: "bg-[#F87171]/15 text-[#F87171] border-[#F87171]/40",
  HIGH: "bg-[#FBBF24]/15 text-[#FBBF24] border-[#FBBF24]/40",
  NORMAL: "bg-[#22D3EE]/10 text-[#22D3EE] border-[#22D3EE]/30",
  LOW: "bg-[#8D9AB3]/10 text-[#8D9AB3] border-[#8D9AB3]/30",
};

function deliveryTone(state: string): string {
  if (state === "delivered") return "text-[#4ADE80]";
  if (state === "dead_letter") return "text-[#F87171]";
  if (state === "unconfigured") return "text-[#8D9AB3]";
  return "text-[#FBBF24]";
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export const NotificationsScreen: React.FC = () => {
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [criticalUnread, setCriticalUnread] = useState(0);
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [inbox, channelData, dead, reportData, scheduleData] = await Promise.all([
        api<{ events: InboxEvent[]; unread: number; criticalUnread: number }>(
          "/api/notifications/inbox?limit=50"
        ),
        api<{ channels: ChannelState[] }>("/api/notifications/channels"),
        api<{ deliveries: DeadLetter[] }>("/api/notifications/deliveries/dead-letter"),
        api<{ reports: ReportSummary[] }>("/api/forge-reports/reports?limit=20"),
        api<{ schedule: ScheduleState }>("/api/forge-reports/schedule"),
      ]);
      setEvents(inbox.events);
      setUnread(inbox.unread);
      setCriticalUnread(inbox.criticalUnread);
      setChannels(channelData.channels);
      setDeadLetters(dead.deliveries);
      setReports(reportData.reports);
      setSchedule(scheduleData.schedule);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "NOTIFICATIONS_UNAVAILABLE";
      setError(
        code === "UNAUTHORIZED"
          ? "The Owner session is missing or expired. Sign in to read the inbox; nothing is fabricated."
          : `The notification API is unavailable (${code}). No local data is invented.`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "REQUEST_FAILED");
    } finally {
      setBusy(null);
    }
  };

  const markRead = (id: string) =>
    run(id, async () => {
      await api(`/api/notifications/inbox/${id}/read`, { method: "POST" });
      return null;
    });

  const markAllRead = () =>
    run("read-all", async () => {
      const result = await api<{ markedRead: number }>("/api/notifications/inbox/read-all", { method: "POST" });
      return `${result.markedRead} notification(s) marked read.`;
    });

  const retryDelivery = (id: string) =>
    run(id, async () => {
      const result = await api<{ deliveries: DeliveryState[] }>(`/api/notifications/deliveries/${id}/retry`, {
        method: "POST",
      });
      const state = result.deliveries.map((entry) => `${entry.channel}:${entry.state}`).join(", ");
      return `Retry attempted. Durable channel state: ${state}.`;
    });

  const toggleChannel = (channel: ChannelState) =>
    run(channel.channel, async () => {
      await api(`/api/notifications/channels/${channel.channel}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !channel.ownerEnabled }),
      });
      return `${channel.channel} is now ${channel.ownerEnabled ? "disabled" : "enabled"}.`;
    });

  const reviewReport = (id: string) =>
    run(id, async () => {
      const data = await api<{ report: ReportDetail }>(`/api/forge-reports/reports/${id}`);
      setSelectedReport(data.report);
      return null;
    });

  const runReportNow = () =>
    run("report-run", async () => {
      const data = await api<{ report: ReportDetail; deduplicated: boolean }>("/api/forge-reports/reports/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSelectedReport(data.report);
      return data.deduplicated
        ? "A report for this date already exists; the stored report was returned."
        : "Report generated from persisted records.";
    });

  const saveSchedule = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run("schedule", async () => {
      const data = await api<{ schedule: ScheduleState }>("/api/forge-reports/schedule", {
        method: "PATCH",
        body: JSON.stringify({
          localHour: Number(form.get("localHour")),
          localMinute: Number(form.get("localMinute")),
          timezone: String(form.get("timezone")),
        }),
      });
      setSchedule(data.schedule);
      return `Schedule saved: ${data.schedule.localTime} ${data.schedule.timezone}.`;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">Owner Inbox &amp; Daily Report</h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Durable notification custody. A stored notification is not proof of external delivery — each channel shows its
          real state, and the daily report is generated from persisted records only.
        </p>
      </div>

      {error && (
        <div className="bg-[#2A1215] border border-[#F87171]/40 rounded-xl px-4 py-3 text-xs text-[#FCA5A5]">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-[#0D1A16] border border-[#4ADE80]/30 rounded-xl px-4 py-3 text-xs text-[#86EFAC]">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-[#8D9AB3]">Unread</div>
          <div className="text-2xl font-bold text-[#E8EEF8] mt-1">{unread}</div>
        </div>
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-[#8D9AB3]">Critical unread</div>
          <div className="text-2xl font-bold text-[#F87171] mt-1">{criticalUnread}</div>
        </div>
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-[#8D9AB3]">Dead letters</div>
          <div className="text-2xl font-bold text-[#FBBF24] mt-1">{deadLetters.length}</div>
        </div>
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-[#8D9AB3]">Next report</div>
          <div className="text-xs font-mono text-[#22D3EE] mt-2 break-words">
            {schedule ? `${formatTime(schedule.nextRunAt)} · ${schedule.localTime} ${schedule.timezone}` : "—"}
          </div>
        </div>
      </div>

      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl">
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[#1E2A40]">
          <h2 className="text-sm font-bold text-[#E8EEF8]">Inbox</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={busy !== null || unread === 0}
              className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>
        </header>
        {loading ? (
          <div className="px-5 py-8 text-center text-xs text-[#8D9AB3]">Loading durable inbox…</div>
        ) : events.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-[#8D9AB3]">No notifications have been persisted yet.</div>
        ) : (
          <ul className="divide-y divide-[#1E2A40]">
            {events.map((event) => (
              <li key={event.id} className={`px-5 py-4 space-y-2.5 ${event.unread ? "bg-[#101A2B]/40" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                          PRIORITY_CLASS[event.priority] ?? PRIORITY_CLASS.LOW
                        }`}
                      >
                        {event.priority}
                      </span>
                      <span className="text-sm font-semibold text-[#E8EEF8]">{event.eventType}</span>
                      {event.unread && <span className="text-[10px] text-[#22D3EE]">UNREAD</span>}
                    </div>
                    <div className="text-[11px] text-[#8D9AB3] mt-1 font-mono break-all">
                      {formatTime(event.createdAt)}
                      {event.taskRef ? ` · ref ${event.taskRef}` : ""}
                      {event.directorId ? ` · director ${event.directorId}` : ""}
                    </div>
                  </div>
                  {event.unread && (
                    <button
                      type="button"
                      onClick={() => void markRead(event.id)}
                      disabled={busy !== null}
                      className="text-[11px] px-2 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
                    >
                      Mark read
                    </button>
                  )}
                </div>
                {typeof event.payload?.message === "string" && (
                  <p className="text-xs text-[#C7D2E4]">{event.payload.message}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {event.deliveries.map((delivery) => (
                    <span
                      key={`${event.id}-${delivery.channel}`}
                      className="text-[10px] font-mono px-2 py-1 rounded border border-[#1E2A40] bg-[#0A111C]"
                    >
                      <span className={deliveryTone(delivery.state)}>{delivery.channel}</span>
                      <span className="text-[#8D9AB3]">
                        {" "}
                        · {delivery.state} · {delivery.attempts}/{delivery.maxAttempts}
                        {delivery.errorClass ? ` · ${delivery.errorClass}` : ""}
                      </span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl">
        <header className="px-5 py-3 border-b border-[#1E2A40]">
          <h2 className="text-sm font-bold text-[#E8EEF8]">Delivery channels</h2>
          <p className="text-[11px] text-[#8D9AB3] mt-0.5">
            Unconfigured channels are recorded honestly; nothing is delivered through them.
          </p>
        </header>
        <ul className="divide-y divide-[#1E2A40]">
          {channels.map((channel) => (
            <li key={channel.channel} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm text-[#E8EEF8] font-mono">{channel.channel}</div>
                <div className="text-[11px] text-[#8D9AB3]">
                  {channel.configured ? "configured" : "unconfigured"}
                  {channel.transport ? ` · ${channel.transport}` : ""}
                  {channel.statusReason ? ` · ${channel.statusReason}` : ""}
                  {channel.requiredSecretName && !channel.runtimeConfigured
                    ? ` · requires ${channel.requiredSecretName}`
                    : ""}
                </div>
              </div>
              {channel.immutable ? (
                <span className="text-[10px] font-mono text-[#8D9AB3]">custody channel</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void toggleChannel(channel)}
                  disabled={busy !== null || (!channel.runtimeConfigured && !channel.ownerEnabled)}
                  className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
                >
                  {channel.ownerEnabled ? "Disable" : "Enable"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {deadLetters.length > 0 && (
        <section className="bg-[#0D1420] border border-[#F87171]/30 rounded-xl">
          <header className="px-5 py-3 border-b border-[#1E2A40]">
            <h2 className="text-sm font-bold text-[#F87171]">Dead-letter deliveries</h2>
          </header>
          <ul className="divide-y divide-[#1E2A40]">
            {deadLetters.map((delivery) => (
              <li key={delivery.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-mono text-[#C7D2E4]">
                  {delivery.eventType ?? "EVENT"} · {delivery.channel} · {delivery.attempts}/{delivery.maxAttempts}
                  {delivery.errorClass ? ` · ${delivery.errorClass}` : ""} · {formatTime(delivery.deadLetteredAt)}
                </div>
                <button
                  type="button"
                  onClick={() => void retryDelivery(delivery.id)}
                  disabled={busy !== null}
                  className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
                >
                  Retry
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[#1E2A40]">
          <div>
            <h2 className="text-sm font-bold text-[#E8EEF8]">Daily FORGE reports</h2>
            <p className="text-[11px] text-[#8D9AB3] mt-0.5">
              Generated from persisted records. Missing evidence is labelled NOT_RUN or BLOCKED.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runReportNow()}
            disabled={busy !== null}
            className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
          >
            Generate now
          </button>
        </header>
        {reports.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-[#8D9AB3]">
            No report has been generated yet. The schedule is{" "}
            {schedule ? `${schedule.localTime} ${schedule.timezone}` : "not loaded"}.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[#8D9AB3] text-left">
              <tr>
                <th className="px-5 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Generated</th>
                <th className="px-3 py-2 font-medium">Evidence hash</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E2A40]">
              {reports.map((report) => (
                <tr key={report.reportId}>
                  <td className="px-5 py-2.5 font-mono text-[#E8EEF8]">{report.reportDate}</td>
                  <td className="px-3 py-2.5">
                    <span className={report.status === "complete" ? "text-[#4ADE80]" : "text-[#FBBF24]"}>
                      {report.status}
                    </span>
                    {report.failedReason ? (
                      <span className="text-[#F87171] font-mono"> · {report.failedReason}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-[#8D9AB3]">{formatTime(report.generatedAt)}</td>
                  <td className="px-3 py-2.5 font-mono text-[#8D9AB3] break-all">
                    {report.evidenceHash ? `${report.evidenceHash.slice(0, 16)}…` : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => void reviewReport(report.reportId)}
                      disabled={busy !== null}
                      className="text-[11px] px-2 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8] disabled:opacity-40"
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedReport && (
        <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl">
          <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[#1E2A40]">
            <div>
              <h2 className="text-sm font-bold text-[#E8EEF8]">Report {selectedReport.reportDate}</h2>
              <p className="text-[11px] text-[#8D9AB3] font-mono break-all">
                {selectedReport.status} · evidence {selectedReport.evidenceHash ?? "—"} ·{" "}
                {selectedReport.payloadHashVerified ? "hash verified" : "hash mismatch"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedReport(null)}
              className="text-[11px] px-2.5 py-1 rounded border border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
            >
              Close
            </button>
          </header>
          <div className="px-5 py-4 space-y-4">
            {selectedReport.executiveSummary ? (
              <div className="space-y-2">
                <div className="text-xs text-[#8D9AB3]">
                  Overall condition:{" "}
                  <span className="text-[#E8EEF8] font-semibold">
                    {selectedReport.executiveSummary.overallCondition}
                  </span>{" "}
                  · Production activity:{" "}
                  <span className="text-[#E8EEF8] font-semibold">
                    {selectedReport.executiveSummary.productionActivity ? "yes" : "no"}
                  </span>
                </div>
                <p className="text-xs text-[#C7D2E4]">{selectedReport.executiveSummary.productionActivityDetail}</p>
                <ul className="list-disc pl-5 text-xs text-[#C7D2E4] space-y-1">
                  {selectedReport.executiveSummary.whatChanged.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {selectedReport.executiveSummary.remainsBlocked.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-[#FBBF24]">Blocked</div>
                    <ul className="list-disc pl-5 text-xs text-[#C7D2E4] space-y-1">
                      {selectedReport.executiveSummary.remainsBlocked.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[#8D9AB3]">This report has no stored payload.</div>
            )}

            {selectedReport.sections && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {Object.entries(selectedReport.sections).map(([name, section]) => (
                  <details key={name} className="bg-[#0A111C] border border-[#1E2A40] rounded-lg px-3 py-2">
                    <summary className="text-xs font-semibold text-[#E8EEF8] cursor-pointer">{name}</summary>
                    <pre className="text-[10px] text-[#8D9AB3] mt-2 whitespace-pre-wrap break-words">
                      {JSON.stringify(section, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            )}

            <div>
              <div className="text-xs font-semibold text-[#8D9AB3]">Evidence</div>
              <p className="text-[11px] font-mono text-[#22D3EE] break-all mt-1">
                sha256:{selectedReport.evidenceHash ?? "—"}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {selectedReport.evidenceRefs.map((ref) => (
                  <span
                    key={`${ref.kind}-${ref.table ?? "ref"}`}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[#1E2A40] text-[#8D9AB3]"
                  >
                    {ref.kind}:{ref.table ?? ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl">
        <header className="px-5 py-3 border-b border-[#1E2A40]">
          <h2 className="text-sm font-bold text-[#E8EEF8]">Report schedule</h2>
          <p className="text-[11px] text-[#8D9AB3] mt-0.5">
            Default 08:00 Asia/Kolkata. The next run is the durable database value, independent of this browser.
          </p>
        </header>
        {schedule && (
          <div className="px-5 py-3 text-[11px] text-[#8D9AB3] font-mono space-y-1">
            <div>last run: {formatTime(schedule.lastRunAt)}</div>
            <div>next run: {formatTime(schedule.nextRunAt)}</div>
            <div>
              policy: {schedule.missedRunPolicy} · enabled: {schedule.enabled ? "yes" : "no"}
            </div>
          </div>
        )}
        <form onSubmit={(event) => void saveSchedule(event)} className="px-5 pb-4 flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-[#8D9AB3]">
            Hour
            <input
              name="localHour"
              type="number"
              min={0}
              max={23}
              defaultValue={schedule?.localHour ?? 8}
              className="block mt-1 w-20 bg-[#0A111C] border border-[#1E2A40] rounded px-2 py-1 text-sm text-[#E8EEF8]"
            />
          </label>
          <label className="text-[11px] text-[#8D9AB3]">
            Minute
            <input
              name="localMinute"
              type="number"
              min={0}
              max={59}
              defaultValue={schedule?.localMinute ?? 0}
              className="block mt-1 w-20 bg-[#0A111C] border border-[#1E2A40] rounded px-2 py-1 text-sm text-[#E8EEF8]"
            />
          </label>
          <label className="text-[11px] text-[#8D9AB3]">
            Time zone
            <input
              name="timezone"
              type="text"
              defaultValue={schedule?.timezone ?? "Asia/Kolkata"}
              className="block mt-1 w-48 bg-[#0A111C] border border-[#1E2A40] rounded px-2 py-1 text-sm text-[#E8EEF8]"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== null}
            className="text-[11px] px-3 py-1.5 rounded border border-[#22D3EE]/40 text-[#22D3EE] hover:bg-[#22D3EE]/10 disabled:opacity-40"
          >
            Save schedule
          </button>
        </form>
      </section>
    </div>
  );
};
