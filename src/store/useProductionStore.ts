/**
 * Owner Console state store — Day 2 (FORGE).
 *
 * Authoritative rule: PostgreSQL-backed HTTP APIs are the source of production
 * state. This store therefore holds NO demo fixtures. It holds:
 *
 *   - the real Owner session (server-validated via GET /api/auth/me);
 *   - live read models per screen, each with an explicit DataSourceStatus;
 *   - non-sensitive display preferences in localStorage (publishing mode only).
 *
 * localStorage never stores an Owner identity, a session token, a CSRF token, a
 * password or any production dataset. A refresh (F5) re-asks the backend who
 * the Owner is; if the answer is 401 the console returns to the login screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OwnerApiClient, ApiError, describeFailure } from "../api/client";
import { BACKEND_GAPS, createOwnerConsoleApi } from "../api/ownerConsoleApi";
import type {
  HealthDto,
  HermesOverviewDto,
  MemoryEntryDto,
  MetricsDto,
  ReadyDto,
  SessionView,
} from "../types/ownerApi";
import type { DataDomain, DataSourceStatus, DataState } from "../types/dataState";
import { initialSources, pendingStatus } from "../types/dataState";
import {
  mapAgents,
  mapApprovalCards,
  mapChannels,
  mapConnections,
  mapEvidenceList,
  mapHermesDecisions,
  mapMessages,
  mapOwner,
  mapProviders,
  mapReleases,
  mapScheduleViews,
  mapSessionViews,
} from "./liveMappers";
import type { ScheduleView } from "./liveMappers";
import type {
  Agent,
  Channel,
  DirectorMessage,
  DirectorSchedule,
  EvidenceEvent,
  HermesDecision,
  InspectionModalData,
  MediaSlot,
  MessageKind,
  Owner,
  OwnerAvailability,
  ProductionRelease,
  PublishingMode,
  ScreenSection,
} from "../types/models";
import { createId } from "../utils/crypto";

/* ------------------------------------------------------------------ types */

export type SessionStatus =
  | "checking"
  | "anonymous"
  | "authenticated"
  | "mfa_required"
  | "error";

export interface LoginResult {
  error: string | null;
  /** True when the password step succeeded but a TOTP code is still required. */
  mfaRequired?: boolean;
}

/* ------------------------------------------------- local display preferences */

const PREFS_KEY = "stph_owner_console_prefs_v1";

interface Preferences {
  defaultPublishingMode: PublishingMode;
}

function loadPreferences(): Preferences {
  const fallback: Preferences = { defaultPublishingMode: "dry_run" };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      defaultPublishingMode: parsed.defaultPublishingMode === "live" ? "live" : "dry_run",
    };
  } catch {
    return fallback;
  }
}

function persistPreferences(prefs: Preferences) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable; a display preference is not critical state.
  }
}

/* ------------------------------------------------------------- status utils */

function liveStatus(): DataSourceStatus {
  return {
    state: "live",
    lastUpdatedAt: new Date().toISOString(),
    error: null,
    detail: null,
  };
}

function unavailableStatus(detail: string): DataSourceStatus {
  return { state: "unavailable", lastUpdatedAt: null, error: null, detail };
}

function failureStatus(error: unknown, previous: DataSourceStatus): DataSourceStatus {
  const isApi = error instanceof ApiError;
  const kind = isApi ? error.kind : "unknown";
  let state: DataState = "error";
  if (kind === "unauthorized") state = "unauthorized";
  else if (kind === "network") state = "offline";
  else if (kind === "unavailable") state = "unavailable";
  else if (kind === "forbidden") state = "error";
  // Data already on screen from an earlier successful read is STALE, not live.
  if (previous.lastUpdatedAt && kind !== "unauthorized") state = "stale";
  return {
    state,
    lastUpdatedAt: previous.lastUpdatedAt,
    error: describeFailure(error),
    detail: isApi ? error.code : null,
  };
}

/** Failure text for an Owner-facing action result (never a stack trace). */
export function describeActionFailure(error: unknown): string {
  return describeFailure(error);
}

/* ------------------------------------------------------------------- store */

export function useProductionStore() {
  const apiClientRef = useRef<OwnerApiClient | null>(null);
  const sessionExpiredRef = useRef(false);

  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("checking");
  const [currentOwner, setCurrentOwner] = useState<Owner | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [sources, setSources] = useState<Record<DataDomain, DataSourceStatus>>(
    initialSources
  );

  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [releases, setReleases] = useState<ProductionRelease[]>([]);
  const [scheduleViews, setScheduleViews] = useState<Record<string, ScheduleView>>({});
  const [approvals, setApprovals] = useState<ReturnType<typeof mapApprovalCards>>([]);
  const [connections, setConnections] = useState<ReturnType<typeof mapConnections>>([]);
  const [providers, setProviders] = useState<ReturnType<typeof mapProviders>>([]);
  const [evidenceEvents, setEvidenceEvents] = useState<EvidenceEvent[]>([]);
  const [hermesDecisions, setHermesDecisions] = useState<HermesDecision[]>([]);
  const [hermesOverview, setHermesOverview] = useState<HermesOverviewDto | null>(null);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntryDto[]>([]);
  const [messages, setMessages] = useState<DirectorMessage[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [metrics, setMetrics] = useState<MetricsDto | null>(null);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [ready, setReady] = useState<ReadyDto | null>(null);

  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [currentSection, setCurrentSection] = useState<ScreenSection>("overview");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("agent-01");
  const [schedulerFeedback, setSchedulerFeedback] = useState<string | null>(null);
  const [channelSearchQuery, setChannelSearchQuery] = useState<string>("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("ALL");
  const [evidenceFilter, setEvidenceFilter] = useState<string>("ALL");
  const [inspectionData, setInspectionData] = useState<InspectionModalData | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /* ----------------------------------------------------- client + callbacks */

  const handleUnauthorized = useCallback(() => {
    if (sessionExpiredRef.current) return;
    sessionExpiredRef.current = true;
    setCurrentOwner(null);
    setSessionStatus("anonymous");
    setSessionExpired(true);
    setMfaRequired(false);
    setSessionError(
      "Your Owner session expired or was revoked. Sign in again — no local state was trusted."
    );
  }, []);

  if (!apiClientRef.current) {
    apiClientRef.current = new OwnerApiClient({ onUnauthorized: handleUnauthorized });
  }
  const api = useMemo(
    () => createOwnerConsoleApi(apiClientRef.current as OwnerApiClient),
    []
  );

  const setSource = useCallback(
    (domain: DataDomain, next: DataSourceStatus | ((prev: DataSourceStatus) => DataSourceStatus)) => {
      setSources((prev) => ({
        ...prev,
        [domain]: typeof next === "function" ? next(prev[domain]) : next,
      }));
    },
    []
  );

  /* --------------------------------------------------------- read domains */

  const refreshDirectors = useCallback(async () => {
    try {
      const [agentPayload, channelPayload] = await Promise.all([
        api.listAgents(),
        api.listChannels(),
      ]);
      const nextAgents = mapAgents(agentPayload);
      setAgents(nextAgents);
      setChannels(mapChannels(channelPayload));
      setSource("directors", () => liveStatus());
      setSelectedAgentId((prev) =>
        nextAgents.some((agent) => agent.id === prev) ? prev : nextAgents[0]?.id ?? prev
      );
    } catch (error) {
      setSource("directors", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshOverview = useCallback(async () => {
    try {
      const [metricsPayload, healthPayload, readyPayload] = await Promise.all([
        api.metrics(),
        api.health(),
        api.ready().catch(() => null),
      ]);
      setMetrics((metricsPayload as MetricsDto) ?? null);
      setHealth((healthPayload as HealthDto) ?? null);
      setReady((readyPayload as ReadyDto | null) ?? null);
      setSource("overview", () => liveStatus());
    } catch (error) {
      setSource("overview", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshSchedule = useCallback(async () => {
    try {
      const payload = await api.listDirectorSchedules();
      setScheduleViews(mapScheduleViews(payload));
      setSource("schedule", () => liveStatus());
    } catch (error) {
      setSource("schedule", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshProduction = useCallback(async () => {
    try {
      const payload = await api.listProductions();
      setReleases(mapReleases(payload));
      setSource("production", () => liveStatus());
    } catch (error) {
      setSource("production", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshApprovals = useCallback(async () => {
    try {
      const payload = await api.listApprovals();
      setApprovals(mapApprovalCards(payload));
      setSource("approvals", () => liveStatus());
    } catch (error) {
      setSource("approvals", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshProviders = useCallback(async () => {
    try {
      const payload = await api.providerCatalog();
      setProviders(mapProviders(payload));
      setSource("providers", () => liveStatus());
    } catch (error) {
      setSource("providers", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshEvidence = useCallback(async () => {
    try {
      const payload = await api.listEvidence();
      setEvidenceEvents(mapEvidenceList(payload));
      setSource("evidence", () => liveStatus());
    } catch (error) {
      setSource("evidence", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshHermes = useCallback(async () => {
    try {
      const [overviewPayload, decisionsPayload] = await Promise.all([
        api.hermesOverview(),
        api.hermesDecisions(50),
      ]);
      setHermesOverview((overviewPayload as HermesOverviewDto) ?? null);
      setHermesDecisions(mapHermesDecisions(decisionsPayload));
      setSource("hermes", () => liveStatus());
    } catch (error) {
      setSource("hermes", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshSessions = useCallback(async () => {
    try {
      const payload = await api.listSessions();
      setSessions(mapSessionViews(payload));
      setSource("settings", () => liveStatus());
    } catch (error) {
      setSource("settings", (prev) => failureStatus(error, prev));
    }
  }, [api, setSource]);

  const refreshConnections = useCallback(
    async (agentId: string) => {
      if (!agentId) {
        setSource("connections", unavailableStatus("No Director is selected."));
        return;
      }
      try {
        const payload = await api.listConnections(agentId);
        setConnections(mapConnections(payload));
        setSource("connections", () => liveStatus());
      } catch (error) {
        setSource("connections", (prev) => failureStatus(error, prev));
      }
    },
    [api, setSource]
  );

  const refreshMemory = useCallback(
    async (agentId: string) => {
      if (!agentId) {
        setSource("memory", unavailableStatus("No Director is selected."));
        return;
      }
      try {
        const payload = await api.listMemory(agentId);
        const rows = Array.isArray(payload?.entries) ? payload.entries : [];
        setMemoryEntries(
          rows
            .filter((row: unknown) => row && typeof row === "object")
            .map((row: Record<string, unknown>) => ({
              id: typeof row.id === "string" ? row.id : undefined,
              category: typeof row.category === "string" ? row.category : "uncategorised",
              content: typeof row.content === "string" ? row.content : "",
              updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
            }))
        );
        setSource("memory", () => liveStatus());
      } catch (error) {
        setSource("memory", (prev) => failureStatus(error, prev));
      }
    },
    [api, setSource]
  );

  const refreshConversation = useCallback(
    async (agentId: string) => {
      if (!agentId) {
        setSource("communication", unavailableStatus("No Director is selected."));
        return;
      }
      try {
        const payload = await api.listMessages(agentId);
        setMessages((prev) => [
          ...prev.filter((message) => message.agentId !== agentId),
          ...mapMessages(agentId, payload),
        ]);
        setSource("communication", () => liveStatus());
      } catch (error) {
        setSource("communication", (prev) => failureStatus(error, prev));
      }
    },
    [api, setSource]
  );

  /** Jobs has no collection route in this repository — report the gap honestly. */
  const markJobsUnavailable = useCallback(() => {
    setSource("jobs", (prev) =>
      prev.state === "live" ? prev : unavailableStatus(BACKEND_GAPS.jobList)
    );
  }, [setSource]);

  const refreshAll = useCallback(async () => {
    markJobsUnavailable();
    setSource("connections", (prev) =>
      prev.state === "live" ? prev : pendingStatus()
    );
    await Promise.all([
      refreshOverview(),
      refreshDirectors(),
      refreshSchedule(),
      refreshProduction(),
      refreshApprovals(),
      refreshProviders(),
      refreshEvidence(),
      refreshHermes(),
      refreshSessions(),
    ]);
  }, [
    markJobsUnavailable,
    refreshApprovals,
    refreshDirectors,
    refreshEvidence,
    refreshHermes,
    refreshOverview,
    refreshProduction,
    refreshProviders,
    refreshSchedule,
    refreshSessions,
    setSource,
  ]);

  /* ------------------------------------------------------------- session */

  const restoreSession = useCallback(async () => {
    setSessionStatus("checking");
    try {
      const me = await api.me();
      const owner = mapOwner(me);
      if (!owner) {
        setSessionStatus("anonymous");
        setCurrentOwner(null);
        return;
      }
      setCurrentOwner(owner);
      setSessionExpired(false);
      setSessionError(null);
      const assurance = typeof me?.session?.mfaAssuranceLevel === "string"
        ? me.session.mfaAssuranceLevel
        : null;
      const needsMfa = me?.mfaEnabled === true && assurance !== "high_assurance";
      setMfaRequired(needsMfa);
      setSessionStatus(needsMfa ? "mfa_required" : "authenticated");
      setSource("session", { state: "live", lastUpdatedAt: new Date().toISOString(), error: null });
      if (!needsMfa) await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.kind === "unauthorized") {
        setSessionStatus("anonymous");
        setCurrentOwner(null);
        setSource("session", {
          state: "unauthorized",
          lastUpdatedAt: null,
          error: null,
          detail: "No Owner session cookie is present.",
        });
        return;
      }
      setSessionStatus("error");
      setCurrentOwner(null);
      setSessionError(describeFailure(error));
      setSource("session", (prev) => failureStatus(error, prev));
    }
  }, [api, refreshAll, setSource]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) {
        return { error: "Enter the Owner email and password." };
      }
      setSessionError(null);
      setBusy(true);
      try {
        const payload = await api.login(trimmedEmail, password);
        const owner = mapOwner(payload?.owner);
        if (!owner) {
          return { error: "The backend did not return an Owner identity." };
        }
        setCurrentOwner(owner);
        sessionExpiredRef.current = false;
        setSessionExpired(false);
        setSource("session", { state: "live", lastUpdatedAt: new Date().toISOString(), error: null });
        const assurance = typeof payload?.session?.mfaAssuranceLevel === "string"
          ? payload.session.mfaAssuranceLevel
          : "password_only";
        const needsMfa = owner && payload?.owner?.mfaEnabled === true && assurance !== "high_assurance";
        if (needsMfa) {
          setMfaRequired(true);
          setSessionStatus("mfa_required");
          return { error: null, mfaRequired: true };
        }
        setMfaRequired(false);
        setSessionStatus("authenticated");
        await refreshAll();
        return { error: null };
      } catch (error) {
        setCurrentOwner(null);
        setSessionStatus("anonymous");
        const message =
          error instanceof ApiError && (error.kind === "validation" || error.kind === "unauthorized")
            ? "Invalid email or password."
            : describeFailure(error);
        setSessionError(message);
        return { error: message };
      } finally {
        setBusy(false);
      }
    },
    [api, refreshAll, setSource]
  );

  const verifyMfa = useCallback(
    async (totpCode: string): Promise<LoginResult> => {
      const code = totpCode.trim();
      if (!/^[0-9]{6,8}$/.test(code)) {
        return { error: "Enter the 6–8 digit code from your authenticator app." };
      }
      setBusy(true);
      try {
        await api.verifyTotp(code);
        const me = await api.me();
        const owner = mapOwner(me);
        if (!owner) return { error: "The backend did not return an Owner identity." };
        setCurrentOwner(owner);
        setMfaRequired(false);
        setSessionStatus("authenticated");
        setSessionError(null);
        await refreshAll();
        return { error: null };
      } catch (error) {
        const message = describeFailure(error);
        setSessionError(message);
        return { error: message };
      } finally {
        setBusy(false);
      }
    },
    [api, refreshAll]
  );

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      // A logout that could not reach the backend must still clear local state;
      // the server session expires on its own schedule.
    } finally {
      apiClientRef.current?.clearCsrfToken();
      sessionExpiredRef.current = true;
      setCurrentOwner(null);
      setMfaRequired(false);
      setSessionStatus("anonymous");
      setSessionError(null);
      setSessionExpired(false);
      setAgents([]);
      setChannels([]);
      setReleases([]);
      setScheduleViews({});
      setApprovals([]);
      setConnections([]);
      setProviders([]);
      setEvidenceEvents([]);
      setHermesDecisions([]);
      setHermesOverview(null);
      setMemoryEntries([]);
      setMessages([]);
      setSessions([]);
      setMetrics(null);
      setSources(initialSources());
      setCurrentSection("overview");
      setBusy(false);
    }
  }, [api]);

  /* ------------------------------------------------------------- mount */

  useEffect(() => {
    void restoreSession();
    // Intentionally once: restoreSession is re-created only by client identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------------------- selection-scoped domains */

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !selectedAgentId) return;
    void refreshMemory(selectedAgentId);
    void refreshConnections(selectedAgentId);
    void refreshConversation(selectedAgentId);
  }, [sessionStatus, selectedAgentId, refreshMemory, refreshConnections, refreshConversation]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") markJobsUnavailable();
  }, [sessionStatus, markJobsUnavailable]);

  /* ---------------------------------------------------------- preferences */

  const setDefaultPublishingMode = useCallback((mode: PublishingMode) => {
    setPreferences((prev) => {
      const next = { ...prev, defaultPublishingMode: mode };
      persistPreferences(next);
      return next;
    });
  }, []);

  /* -------------------------------------------------------------- actions */

  const withAction = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await operation();
    } catch (error) {
      setActionError(describeFailure(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const addChannel = useCallback(
    async (
      slug: string,
      displayName: string,
      tagline: string,
      language: string,
      agentId: string
    ) => {
      const cleanSlug = slug.trim().toLowerCase().replace(/\s+/g, "-");
      await withAction(async () => {
        await api.createChannel({
          slug: cleanSlug,
          displayName: displayName.trim(),
          tagline: tagline.trim() || undefined,
          language: language.trim() || undefined,
          agentId,
        });
        await refreshDirectors();
      });
    },
    [api, refreshDirectors, withAction]
  );

  const saveSchedule = useCallback(
    async (schedule: DirectorSchedule) => {
      await withAction(async () => {
        await api.saveDirectorSchedule(schedule.agentId, {
          episodeDurationSeconds: schedule.mainEpisodeDuration,
          episodesPerDay: schedule.episodesPerDay,
          productionDays: schedule.productionDays,
          productionStartTime: schedule.preferredStartTime,
          timezone: schedule.timezone,
          scheduleEnabled: schedule.enabled,
        });
        await refreshSchedule();
        setSchedulerFeedback(
          `Schedule persisted for Director ${schedule.agentId} (${schedule.episodesPerDay} eps/day, ${Math.round(
            schedule.mainEpisodeDuration / 60
          )}m).`
        );
      });
    },
    [api, refreshSchedule, withAction]
  );

  const previewSchedulePlan = useCallback(
    (agentId: string) => {
      const view = scheduleViews[agentId];
      if (!view) {
        setSchedulerFeedback(
          "No backend schedule record exists for this Director yet; nothing can be previewed until one is saved."
        );
        return;
      }
      if (view.schedule.mainEpisodeDuration <= 0) {
        setSchedulerFeedback(
          "The stored schedule failed backend validation, so the planner cannot preview it."
        );
        return;
      }
      setSchedulerFeedback(
        `Persisted plan: ${view.schedule.episodesPerDay} slot(s)/day on production days ${
          view.schedule.productionDays.join(", ") || "none"
        } starting ${view.schedule.preferredStartTime} (${view.schedule.timezone}). ${
          view.schedule.enabled ? "Schedule enabled." : "Schedule paused."
        } Quota state is not exposed by any backend route.`
      );
    },
    [scheduleViews]
  );

  const runSchedulerNow = useCallback(
    async (agentId: string) => {
      await withAction(async () => {
        const result = await api.runDirectorSchedule(agentId);
        const body =
          result && typeof result === "object"
            ? JSON.stringify(result).slice(0, 600)
            : "The backend returned no body.";
        setSchedulerFeedback(`Scheduler response for Director ${agentId}: ${body}`);
        await Promise.all([refreshSchedule(), refreshProduction()]);
      });
    },
    [api, refreshProduction, refreshSchedule, withAction]
  );

  const startProductionRelease = useCallback(
    async (channelId: string, title: string, season: number, episode: number) => {
      await withAction(async () => {
        await api.createProduction({ channelId, title: title.trim(), season, episode });
        await refreshProduction();
      });
    },
    [api, refreshProduction, withAction]
  );

  const advancePipelineStage = useCallback(
    async (releaseId: string) => {
      await withAction(async () => {
        await api.runProduction(releaseId);
        await refreshProduction();
      });
    },
    [api, refreshProduction, withAction]
  );

  const sendDirectorMessage = useCallback(
    async (agentId: string, kind: MessageKind, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      if (trimmed.length > 4000) {
        setActionError("The backend accepts at most 4000 characters per Director message.");
        return;
      }
      const clientMessageId = createId();
      await withAction(async () => {
        let payload: any = null;
        try {
          payload = await api.sendMessage(agentId, { body: trimmed, kind, clientMessageId });
        } finally {
          // Re-read the durable conversation either way: no optimistic message can
          // masquerade as a stored one, and a provider failure is visible.
          await refreshConversation(agentId);
        }
        if (payload && typeof payload === "object" && payload.directorResponse) {
          // The durable read above is authoritative; this only refreshes status.
          setSource("communication", () => liveStatus());
        }
      });
    },
    [api, refreshConversation, setSource, withAction]
  );

  const inspectArtifact = useCallback((slot: MediaSlot) => {
    setInspectionData({
      title: slot.artifactTitle ?? slot.label,
      slotKey: slot.key,
      durationSeconds: slot.durationSeconds ?? 0,
      resolution: slot.resolution,
      aspectRatio: slot.aspectRatio,
      lufs: slot.lufsAudio,
      codec: slot.codec,
      sha256: slot.artifactHash ?? "",
      isVerified: slot.verified,
    });
  }, []);

  /* --------------------------------------------------------------- return */

  const schedules = useMemo(() => {
    const out: Record<string, DirectorSchedule> = {};
    for (const [agentId, view] of Object.entries(scheduleViews)) {
      out[agentId] = view.schedule;
    }
    return out;
  }, [scheduleViews]);

  const ownerAvailability: OwnerAvailability | "unknown" = "unknown";

  return {
    /* session */
    sessionStatus,
    currentOwner,
    sessionError,
    sessionExpired,
    mfaRequired,
    login,
    verifyMfa,
    logout,
    restoreSession,
    refreshAll,

    /* live read models */
    agents,
    channels,
    releases,
    schedules,
    scheduleViews,
    approvals,
    connections,
    providers,
    evidenceEvents,
    hermesDecisions,
    hermesOverview,
    memoryEntries,
    messages,
    sessions,
    metrics,
    health,
    ready,

    /* data-source status */
    sources,
    backendGaps: BACKEND_GAPS,

    /* runtime/storage facts */
    storageMode: health?.storage ?? (health ? "unreachable" : "unknown"),
    storageStatus: ready?.status ?? (health?.status ?? "unknown"),

    /* preferences */
    defaultPublishingMode: preferences.defaultPublishingMode,
    setDefaultPublishingMode,
    ownerAvailability,

    /* UI state */
    currentSection,
    navigateTo: setCurrentSection,
    selectedAgentId,
    selectAgent: setSelectedAgentId,
    schedulerFeedback,
    clearSchedulerFeedback: () => setSchedulerFeedback(null),
    channelSearchQuery,
    setChannelSearchQuery,
    jobStatusFilter,
    setJobStatusFilter,
    evidenceFilter,
    setEvidenceFilter,
    inspectionData,
    dismissInspection: () => setInspectionData(null),
    busy,
    actionError,
    dismissActionError: () => setActionError(null),

    /* actions */
    addChannel,
    saveSchedule,
    previewSchedulePlan,
    runSchedulerNow,
    sendDirectorMessage,
    startProductionRelease,
    advancePipelineStage,
    inspectArtifact,
    refreshConnections,
    refreshMemory,
    refreshConversation,
    refreshProduction,
    refreshSchedule,
    refreshApprovals,
    refreshEvidence,
    refreshHermes,
    refreshProviders,
    markJobsUnavailable,
  };
}
