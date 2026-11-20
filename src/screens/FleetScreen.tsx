import React, { useCallback, useEffect, useState } from "react";

/**
 * Owner Director Fleet console (Day 5).
 *
 * Backed only by `/api/fleet`. The screen never invents a Director, a task
 * count, a health state or a blocker: when the API is unavailable it says so.
 * Lifecycle actions are confirmation-gated and require the Owner session, and
 * the API (not this screen) is the authority that refuses an illegal
 * transition. Secrets are never rendered — provider references are shown as
 * masked status, and the API never returns credential values.
 */

interface FleetDirectorRow {
  directorId: string;
  displayName: string;
  universeName: string | null;
  niche: string | null;
  lifecycleState: string;
  healthState: string;
  activeTasks: number;
  queuedTasks: number;
  blockedTasks: number;
  failedTasks: number;
  completedTasks: number;
  providerBlocked: boolean;
  oldestQueuedSeconds: number | null;
  lastActivityAt: string | null;
  escalationCode: string | null;
}

interface FleetCounts {
  total: number;
  active: number;
  ready: number;
  paused: number;
  suspended: number;
  retired: number;
  withActiveTasks: number;
  withBlockedTasks: number;
  withFailedTasks: number;
  providerBlocked: number;
  healthy: number;
  degraded: number;
  blocked: number;
  offline: number;
  notConfigured: number;
}

interface FleetPayload {
  generatedAt: string;
  capacity: { limit: number; used: number };
  counts: FleetCounts;
  workers: { total: number; live: number; expired: number };
  directors: FleetDirectorRow[];
}

interface Requirement {
  code: string;
  satisfied: boolean;
  detail: string;
}

interface DirectorTask {
  taskId: string;
  stage: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  blockedReason: string | null;
  lastError: string | null;
}

interface DirectorProject {
  projectId: string;
  projectKey: string;
  universeId: string;
  title: string;
  state: string;
}

interface AuditEntry {
  auditId: string;
  action: string;
  previousState: string | null;
  newState: string | null;
  reason: string;
  actorRole: string;
  createdAt: string;
}

interface DirectorDetail {
  director: {
    directorId: string;
    displayName: string;
    universeName: string | null;
    niche: string | null;
    genres: unknown;
    contentFormats: unknown;
    languages: unknown;
    targetAudience: string | null;
    creativeDirection: string | null;
    lifecycleState: string;
    providerConfig: Record<string, unknown>;
    platformConnections: Record<string, unknown>;
    ownerAuthorizedAt: string | null;
    updatedAt: string;
  };
  readiness: { ready: boolean; requirements: Requirement[]; missing: string[] };
  workCapable: boolean;
  projects: DirectorProject[];
  tasks: DirectorTask[];
  escalations: Array<{ escalationId: string; code: string; severity: string; createdAt: string }>;
  audit: AuditEntry[];
}

interface WorkerRow {
  workerKey: string;
  instanceId: string;
  state: string;
  stageTypes: string[];
  capabilities: string[];
  directorScope: string[];
  currentTaskId: string | null;
  currentDirectorId: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  lastCompletedAt: string | null;
  failureCount: number;
  leaseViolationCount: number;
  online: boolean;
  expired: boolean;
}

interface WorkerMetrics {
  workers: { registered: number; online: number; offline: number; busy: number; draining: number; degraded: number };
  tasks: {
    claimed: number;
    handlerStarted: number;
    completed: number;
    failed: number;
    retried: number;
    deadLettered: number;
    recoveredAfterRestart: number;
    providerBlocked: number;
    oldestPendingSeconds: number | null;
  };
  evidence: { records: number; productionEligible: number; testFixtures: number; stageTypesExecuted: string[] };
  leaseViolations: { recorded: number };
}

interface DeadLetterRow {
  taskId: string;
  directorId: string;
  stage: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
}

let csrfToken: string | null = null;
async function ownerCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    csrfToken = typeof data?.csrfToken === "string" ? data.csrfToken : null;
    return csrfToken;
  } catch {
    return null;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const token = method === "GET" ? null : await ownerCsrfToken();
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-csrf-token": token } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(typeof data?.code === "string" ? data.code : `HTTP_${res.status}`);
  }
  return data as T;
}

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: "text-[#4ADE80]",
  DEGRADED: "text-[#FBBF24]",
  BLOCKED: "text-[#F87171]",
  OFFLINE: "text-[#8D9AB3]",
  SUSPENDED: "text-[#8D9AB3]",
  NOT_CONFIGURED: "text-[#8D9AB3]",
};

const ACTION_LABEL: Record<string, string> = {
  activate: "Activate",
  pause: "Pause",
  resume: "Resume",
  suspend: "Suspend",
  retire: "Request retirement",
};

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function maskedReferences(value: Record<string, unknown>): string {
  const keys = Object.keys(value ?? {});
  if (keys.length === 0) return "none recorded";
  return `${keys.length} opaque reference(s): ${keys.join(", ")}`;
}

export const FleetScreen: React.FC = () => {
  const [fleet, setFleet] = useState<FleetPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DirectorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [metrics, setMetrics] = useState<WorkerMetrics | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetterRow[]>([]);

  const refreshWorkers = useCallback(async () => {
    try {
      const registry = await api<{ workers: WorkerRow[] }>("/api/fleet/workers/registry");
      setWorkers(registry.workers ?? []);
      setMetrics(await api<WorkerMetrics>("/api/fleet/workers/metrics"));
      const dead = await api<{ tasks: DeadLetterRow[] }>("/api/fleet/tasks/dead-letters?limit=10");
      setDeadLetters(dead.tasks ?? []);
    } catch (caught) {
      // The worker registry failing must not blank the fleet view; it is reported.
      setNotice(caught instanceof Error ? `Worker registry unavailable: ${caught.message}` : null);
    }
  }, []);

  const runWorkerAction = async (workerKey: string, action: "drain" | "restart") => {
    if (!window.confirm(`${action === "drain" ? "Drain" : "Request restart of"} "${workerKey}"? This is audited.`)) return;
    setBusy(`${action}:${workerKey}`);
    try {
      await api(`/api/fleet/workers/${encodeURIComponent(workerKey)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ reason: `Owner ${action} from the worker operations panel.` }),
      });
      setNotice(`${action === "drain" ? "Drain recorded" : "Restart requested"} for ${workerKey}.`);
      await refreshWorkers();
    } catch (caught) {
      setNotice(`${action} refused: ${caught instanceof Error ? caught.message : "UNKNOWN"}`);
    } finally {
      setBusy(null);
    }
  };

  const refreshFleet = useCallback(async () => {
    setError(null);
    try {
      const payload = await api<FleetPayload>("/api/fleet/directors");
      setFleet(payload);
      setSelected((current) => current ?? payload.directors[0]?.directorId ?? null);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "DIRECTOR_FLEET_UNAVAILABLE";
      setError(
        code === "UNAUTHORIZED"
          ? "The Owner session is missing or expired. Sign in to read the fleet; nothing is fabricated."
          : `The fleet API is unavailable (${code}). No local fleet state is invented.`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (directorId: string) => {
    try {
      const payload = await api<DirectorDetail>(`/api/fleet/directors/${directorId}`);
      setDetail(payload);
    } catch (caught) {
      setDetail(null);
      setError(caught instanceof Error ? caught.message : "DIRECTOR_DETAIL_UNAVAILABLE");
    }
  }, []);

  useEffect(() => {
    void refreshFleet();
    void refreshWorkers();
  }, [refreshFleet, refreshWorkers]);

  useEffect(() => {
    if (selected) void refreshDetail(selected);
  }, [selected, refreshDetail]);

  const runAction = async (action: string) => {
    if (!selected) return;
    const label = ACTION_LABEL[action] ?? action;
    if (!window.confirm(`${label} "${selected}"? This is an authenticated, audited lifecycle action.`)) return;
    setBusy(action);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { reason: `${label} requested from the Owner fleet console.` };
      if (action === "retire") body.complete = false;
      await api(`/api/fleet/directors/${selected}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(`${label} recorded for ${selected}.`);
      await refreshFleet();
      await refreshDetail(selected);
    } catch (caught) {
      setNotice(`${label} refused: ${caught instanceof Error ? caught.message : "UNKNOWN"}`);
    } finally {
      setBusy(null);
    }
  };

  const runScan = async () => {
    setBusy("scan");
    setNotice(null);
    try {
      const result = await api<{ escalations: unknown[]; expiredWorkers: unknown[] }>("/api/fleet/health/scan", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setNotice(
        `Health scan persisted ${result.escalations.length} escalation(s); ${result.expiredWorkers.length} expired runtime(s) marked offline.`
      );
      await refreshFleet();
    } catch (caught) {
      setNotice(`Health scan failed: ${caught instanceof Error ? caught.message : "UNKNOWN"}`);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-[#8D9AB3]">Loading the Director fleet…</div>;
  }

  if (error && !fleet) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-[#F87171]/40 bg-[#F87171]/10 p-4 text-sm text-[#F87171]">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[#E6EDF7]">Director Fleet</h1>
          <p className="text-xs text-[#8D9AB3] mt-1">
            Independent universe ownership. Counts come from durable task records; a queued task is never a completed
            stage.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={busy !== null}
          className="rounded-md border border-[#2A3550] px-3 py-1.5 text-xs text-[#E6EDF7] hover:bg-[#1A2338] disabled:opacity-50"
        >
          {busy === "scan" ? "Scanning…" : "Run health scan"}
        </button>
      </header>

      {notice && (
        <div className="rounded-md border border-[#2A3550] bg-[#141C2E] p-3 text-xs text-[#C7D2E5]">{notice}</div>
      )}

      {fleet && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Registered", value: `${fleet.counts.total}/${fleet.capacity.limit}` },
            { label: "Active", value: fleet.counts.active },
            { label: "Ready", value: fleet.counts.ready },
            { label: "Paused / suspended", value: fleet.counts.paused + fleet.counts.suspended },
            { label: "With active tasks", value: fleet.counts.withActiveTasks },
            { label: "With blocked tasks", value: fleet.counts.withBlockedTasks },
            { label: "Provider blocked", value: fleet.counts.providerBlocked },
            { label: "Live runtimes", value: `${fleet.workers.live}/${fleet.workers.total}` },
          ].map((card) => (
            <div key={card.label} className="rounded-lg border border-[#2A3550] bg-[#111A2B] p-3">
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">{card.label}</div>
              <div className="text-lg font-semibold text-[#E6EDF7] mt-1">{card.value}</div>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-lg border border-[#2A3550] bg-[#111A2B] p-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[#E6EDF7]">Worker Operations</h2>
            <p className="text-[11px] text-[#8D9AB3]">
              A registered runtime with a live heartbeat. Counts are separate facts: claimed, handler started,
              completed, evidence verified.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshWorkers()}
            className="rounded-md border border-[#2A3550] px-3 py-1.5 text-xs text-[#E6EDF7] hover:bg-[#1A2338]"
          >
            Refresh workers
          </button>
        </div>

        {metrics && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {[
              { label: "Registered", value: metrics.workers.registered },
              { label: "Online", value: metrics.workers.online },
              { label: "Busy", value: metrics.workers.busy },
              { label: "Tasks claimed", value: metrics.tasks.claimed },
              { label: "Handler started", value: metrics.tasks.handlerStarted },
              { label: "Completed", value: metrics.tasks.completed },
              { label: "Dead-lettered", value: metrics.tasks.deadLettered },
              { label: "Lease violations", value: metrics.leaseViolations.recorded },
              { label: "Evidence records", value: metrics.evidence.records },
              { label: "Fixture evidence", value: metrics.evidence.testFixtures },
              { label: "Recovered after restart", value: metrics.tasks.recoveredAfterRestart },
              { label: "Oldest pending (s)", value: metrics.tasks.oldestPendingSeconds ?? 0 },
            ].map((card) => (
              <div key={card.label} className="rounded border border-[#1F2A41] px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">{card.label}</div>
                <div className="text-sm text-[#E6EDF7]">{card.value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8D9AB3]">
              <tr>
                {["Worker", "State", "Stages", "Director", "Current task", "Heartbeat", "Failures", "Lease", "Controls"].map(
                  (heading) => (
                    <th key={heading} className="text-left font-medium px-2 py-1.5">
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-2 py-3 text-[#8D9AB3]">
                    No worker runtime is registered. A browser session is never counted as a worker.
                  </td>
                </tr>
              )}
              {workers.map((worker) => (
                <tr key={worker.workerKey} className="border-t border-[#1F2A41]">
                  <td className="px-2 py-1.5 text-[#E6EDF7]">{worker.workerKey}</td>
                  <td className={`px-2 py-1.5 ${worker.online ? "text-[#4ADE80]" : "text-[#8D9AB3]"}`}>
                    {worker.state}
                    {worker.online ? " · online" : " · offline"}
                  </td>
                  <td className="px-2 py-1.5 text-[#C7D2E5]">{worker.stageTypes.join(", ") || "—"}</td>
                  <td className="px-2 py-1.5 text-[#C7D2E5]">{worker.currentDirectorId ?? (worker.directorScope.join(", ") || "—")}</td>
                  <td className="px-2 py-1.5 text-[#8D9AB3]">{worker.currentTaskId ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#8D9AB3]">
                    {worker.heartbeatAgeSeconds === null ? "—" : `${worker.heartbeatAgeSeconds}s ago`}
                  </td>
                  <td className="px-2 py-1.5 text-[#C7D2E5]">{worker.failureCount}</td>
                  <td className="px-2 py-1.5 text-[#C7D2E5]">{worker.leaseViolationCount}</td>
                  <td className="px-2 py-1.5 space-x-1">
                    <button
                      type="button"
                      onClick={() => void runWorkerAction(worker.workerKey, "drain")}
                      disabled={busy !== null}
                      className="rounded border border-[#2A3550] px-2 py-0.5 text-[10px] text-[#E6EDF7] hover:bg-[#1A2338] disabled:opacity-50"
                    >
                      Drain
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWorkerAction(worker.workerKey, "restart")}
                      disabled={busy !== null}
                      className="rounded border border-[#2A3550] px-2 py-0.5 text-[10px] text-[#E6EDF7] hover:bg-[#1A2338] disabled:opacity-50"
                    >
                      Restart
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">
            Dead-letter queue ({deadLetters.length})
          </div>
          {deadLetters.length === 0 ? (
            <p className="text-xs text-[#8D9AB3] mt-1">No task reached the dead-letter state.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {deadLetters.map((task) => (
                <li key={task.taskId} className="text-[11px] text-[#F87171]">
                  {task.directorId} · {task.stage} · {task.attemptCount}/{task.maxAttempts} · {task.lastError ?? "—"}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#2A3550] bg-[#111A2B] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#162033] text-[#8D9AB3]">
            <tr>
              {["Director", "Universe", "State", "Health", "Active", "Blocked", "Provider", "Last activity"].map(
                (heading) => (
                  <th key={heading} className="text-left font-medium px-3 py-2">
                    {heading}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {(fleet?.directors ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-[#8D9AB3]">
                  No Director is registered yet. Registration never activates a Director.
                </td>
              </tr>
            )}
            {(fleet?.directors ?? []).map((row) => (
              <tr
                key={row.directorId}
                onClick={() => setSelected(row.directorId)}
                className={`cursor-pointer border-t border-[#1F2A41] hover:bg-[#162033] ${
                  selected === row.directorId ? "bg-[#162033]" : ""
                }`}
              >
                <td className="px-3 py-2 text-[#E6EDF7]">{row.displayName}</td>
                <td className="px-3 py-2 text-[#C7D2E5]">{row.universeName ?? "—"}</td>
                <td className="px-3 py-2 text-[#C7D2E5]">{row.lifecycleState}</td>
                <td className={`px-3 py-2 ${HEALTH_TONE[row.healthState] ?? "text-[#C7D2E5]"}`}>{row.healthState}</td>
                <td className="px-3 py-2 text-[#C7D2E5]">{row.activeTasks}</td>
                <td className="px-3 py-2 text-[#C7D2E5]">{row.blockedTasks}</td>
                <td className="px-3 py-2 text-[#C7D2E5]">{row.providerBlocked ? "BLOCKED" : "OK / unconstrained"}</td>
                <td className="px-3 py-2 text-[#8D9AB3]">{formatTime(row.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-[#2A3550] bg-[#111A2B] p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-[#E6EDF7]">{detail.director.displayName}</h2>
                <p className="text-xs text-[#8D9AB3]">
                  {detail.director.universeName ?? "no universe"} · {detail.director.niche ?? "no niche"}
                </p>
              </div>
              <span className="text-[10px] rounded border border-[#2A3550] px-2 py-0.5 text-[#C7D2E5]">
                {detail.director.lifecycleState}
              </span>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">Readiness</div>
              <ul className="mt-1 space-y-1">
                {detail.readiness.requirements.map((requirement) => (
                  <li key={requirement.code} className="text-xs flex justify-between gap-2">
                    <span className="text-[#C7D2E5]">{requirement.code}</span>
                    <span className={requirement.satisfied ? "text-[#4ADE80]" : "text-[#FBBF24]"}>
                      {requirement.satisfied ? "recorded" : "missing"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="text-xs text-[#8D9AB3] space-y-1">
              <div>Provider references: {maskedReferences(detail.director.providerConfig)}</div>
              <div>Platform connections: {maskedReferences(detail.director.platformConnections)}</div>
              <div>Owner authorization: {detail.director.ownerAuthorizedAt ? "recorded" : "not recorded"}</div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {["activate", "pause", "resume", "suspend", "retire"].map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => void runAction(action)}
                  disabled={busy !== null}
                  className="rounded-md border border-[#2A3550] px-2.5 py-1 text-[11px] text-[#E6EDF7] hover:bg-[#1A2338] disabled:opacity-50"
                >
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </div>
            {detail.readiness.missing.length > 0 && (
              <p className="text-[11px] text-[#FBBF24]">
                Activation will be refused until these are recorded: {detail.readiness.missing.join(", ")}.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-[#2A3550] bg-[#111A2B] p-4 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">Projects ({detail.projects.length})</div>
              {detail.projects.length === 0 ? (
                <p className="text-xs text-[#8D9AB3] mt-1">No project recorded.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {detail.projects.map((project) => (
                    <li key={project.projectId} className="text-xs text-[#C7D2E5]">
                      {project.title} · {project.state} · universe {project.universeId}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">Tasks ({detail.tasks.length})</div>
              {detail.tasks.length === 0 ? (
                <p className="text-xs text-[#8D9AB3] mt-1">No production task recorded.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {detail.tasks.slice(0, 12).map((task) => (
                    <li key={task.taskId} className="text-xs text-[#C7D2E5] flex justify-between gap-2">
                      <span>{task.stage}</span>
                      <span className="text-[#8D9AB3]">
                        {task.status} · {task.attemptCount}/{task.maxAttempts}
                        {task.blockedReason ? ` · ${task.blockedReason}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">Escalations ({detail.escalations.length})</div>
              {detail.escalations.length === 0 ? (
                <p className="text-xs text-[#8D9AB3] mt-1">No escalation recorded.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {detail.escalations.map((escalation) => (
                    <li key={escalation.escalationId} className="text-xs text-[#FBBF24]">
                      {escalation.code} · {escalation.severity} · {formatTime(escalation.createdAt)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#8D9AB3]">Audit history</div>
              <ul className="mt-1 space-y-1 max-h-48 overflow-auto">
                {detail.audit.map((entry) => (
                  <li key={entry.auditId} className="text-[11px] text-[#C7D2E5]">
                    {formatTime(entry.createdAt)} · {entry.action} · {entry.previousState ?? "—"} →{" "}
                    {entry.newState ?? "—"} · {entry.actorRole}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
