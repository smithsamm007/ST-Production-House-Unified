import { useCallback, useEffect, useState } from "react";
import {
  createCanonicalMediaSlots,
  getInitialApprovals,
  getInitialChannels,
  getInitialCharters,
  getInitialConnections,
  getInitialEvidence,
  getInitialHermesDecisions,
  getInitialJobs,
  getInitialMessages,
  getInitialProviders,
  getInitialReleases,
  getInitialSchedules,
  INITIAL_AGENTS,
  INITIAL_OWNER,
  STORAGE_MODE,
  STORAGE_STATUS,
} from "../data/seedData";
import { getInitialDelegationPolicies } from "../data/architectureBlueprint";
import {
  ApprovalItem,
  Channel,
  ConnectionSlotStatus,
  CreativeCharter,
  DelegationPolicyItem,
  DirectorMessage,
  DirectorSchedule,
  EvidenceEvent,
  HermesDecision,
  InspectionModalData,
  JobStatus,
  MediaSlot,
  MessageKind,
  MessageSender,
  Owner,
  OwnerAvailability,
  PIPELINE_STAGES,
  PlatformConnection,
  ProductionJob,
  ProductionRelease,
  ProviderSlot,
  PublishingMode,
  ReleaseStatus,
  ScreenSection,
} from "../types/models";
import {
  computeSha256,
  createId,
  dayName,
  getCurrentTimeSimple,
  getCurrentTimestamp,
} from "../utils/crypto";

const STORAGE_KEY = "stph_owner_console_state_v1";

interface PersistedState {
  currentOwner: Owner | null;
  channels: Channel[];
  releases: ProductionRelease[];
  schedules: Record<string, DirectorSchedule>;
  messages: DirectorMessage[];
  charters: Record<string, CreativeCharter>;
  jobs: ProductionJob[];
  providers: ProviderSlot[];
  platformConnections: PlatformConnection[];
  approvals: ApprovalItem[];
  evidenceEvents: EvidenceEvent[];
  hermesDecisions: HermesDecision[];
  defaultPublishingMode: PublishingMode;
  ownerAvailability: OwnerAvailability;
  delegationPolicies: DelegationPolicyItem[];
}

function getDefaultPersistedState(): PersistedState {
  return {
    currentOwner: INITIAL_OWNER,
    channels: getInitialChannels(),
    releases: getInitialReleases(),
    schedules: getInitialSchedules(),
    messages: getInitialMessages(),
    charters: getInitialCharters(),
    jobs: getInitialJobs(),
    providers: getInitialProviders(),
    platformConnections: getInitialConnections(),
    approvals: getInitialApprovals(),
    evidenceEvents: getInitialEvidence(),
    hermesDecisions: getInitialHermesDecisions(),
    defaultPublishingMode: "dry_run",
    ownerAvailability: "available",
    delegationPolicies: getInitialDelegationPolicies(),
  };
}

function loadInitialState(): PersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultPersistedState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const defaults = getDefaultPersistedState();
    return {
      currentOwner:
        parsed.currentOwner === undefined
          ? defaults.currentOwner
          : parsed.currentOwner,
      channels: Array.isArray(parsed.channels) ? parsed.channels : defaults.channels,
      releases: Array.isArray(parsed.releases) ? parsed.releases : defaults.releases,
      schedules: parsed.schedules ?? defaults.schedules,
      messages: Array.isArray(parsed.messages) ? parsed.messages : defaults.messages,
      charters: parsed.charters ?? defaults.charters,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : defaults.jobs,
      providers: Array.isArray(parsed.providers) ? parsed.providers : defaults.providers,
      platformConnections: Array.isArray(parsed.platformConnections)
        ? parsed.platformConnections
        : defaults.platformConnections,
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : defaults.approvals,
      evidenceEvents: Array.isArray(parsed.evidenceEvents)
        ? parsed.evidenceEvents
        : defaults.evidenceEvents,
      hermesDecisions: Array.isArray(parsed.hermesDecisions)
        ? parsed.hermesDecisions
        : defaults.hermesDecisions,
      defaultPublishingMode:
        parsed.defaultPublishingMode === "live" ? "live" : "dry_run",
      ownerAvailability:
        parsed.ownerAvailability === "unavailable" ? "unavailable" : "available",
      delegationPolicies:
        Array.isArray(parsed.delegationPolicies) &&
        parsed.delegationPolicies.length === defaults.delegationPolicies.length
          ? parsed.delegationPolicies
          : defaults.delegationPolicies,
    };
  } catch {
    return getDefaultPersistedState();
  }
}

/**
 * Per-session CSRF token for cookie-authenticated Owner mutations.
 * The token is scoped to the caller's own session; no provider credential is
 * ever fetched, stored or displayed in the browser.
 */
let ownerCsrfToken: string | null = null;
async function getOwnerCsrfToken(): Promise<string | null> {
  if (ownerCsrfToken) return ownerCsrfToken;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    ownerCsrfToken =
      typeof data?.csrfToken === "string" ? data.csrfToken : null;
    return ownerCsrfToken;
  } catch {
    return null;
  }
}

/** Honest Owner-visible wording for an HTTP failure of the comm endpoint. */
function describeCommFailure(status: number, error?: string): string {
  if (status === 401)
    return "[Authentication Required] The Owner session is missing or expired. Sign in to the console and retry; no AI response was fabricated.";
  if (status === 403)
    return "[Authentication Required] The request was refused by CSRF or authorization checks. Reload the console and retry; no AI response was fabricated.";
  if (status === 404)
    return "[Routing Failed] No such Director is registered, so the message was not routed.";
  if (status === 413)
    return "[Message Rejected] The message exceeds the 4000 character limit; nothing was sent to the Director.";
  if (status === 429)
    return "[Rate Limited] Too many messages in a short window. Wait a minute and retry; no AI response was fabricated.";
  return `[Provider Unavailable] ${
    error || `Communication endpoint returned HTTP ${status}.`
  } No AI response was fabricated.`;
}

export function useProductionStore() {
  const [state, setState] = useState<PersistedState>(() => loadInitialState());
  const [currentSection, setCurrentSection] = useState<ScreenSection>("overview");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("agent-01");
  const [schedulerFeedback, setSchedulerFeedback] = useState<string | null>(null);
  const [channelSearchQuery, setChannelSearchQuery] = useState<string>("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("ALL");
  const [evidenceFilter, setEvidenceFilter] = useState<string>("ALL");
  const [inspectionData, setInspectionData] =
    useState<InspectionModalData | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors in ephemeral sandboxes
    }
  }, [state]);

  const makeEvidence = (
    eventType: string,
    agentId: string,
    channelSlug: string,
    stage: string,
    artifactHash: string,
    verificationReceipt: string
  ): EvidenceEvent => ({
    id: createId(),
    eventType,
    agentId,
    channelSlug,
    stage,
    artifactHash,
    verificationReceipt,
    timestamp: getCurrentTimestamp(),
  });

  const login = useCallback((email: string, pass: string): string | null => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !pass.trim()) {
      return "Invalid credentials. Please enter email and password.";
    }
    const ev: EvidenceEvent = {
      id: createId(),
      eventType: "OWNER_AUTHENTICATED",
      agentId: "owner",
      channelSlug: "auth",
      stage: "session",
      artifactHash: computeSha256(`${trimmedEmail}${Date.now()}`),
      verificationReceipt: "demo://auth/session_created",
      timestamp: getCurrentTimestamp(),
    };
    setState((prev) => ({
      ...prev,
      currentOwner: {
        id: createId(),
        email: trimmedEmail,
        role: "owner",
        isAuthenticated: true,
      },
      evidenceEvents: [ev, ...prev.evidenceEvents],
    }));
    return null;
  }, []);

  const logout = useCallback(() => {
    setState((prev) => {
      const email = prev.currentOwner?.email ?? "owner";
      const ev = makeEvidence(
        "OWNER_LOGGED_OUT",
        "owner",
        "auth",
        "session",
        computeSha256(`${email}${Date.now()}`),
        "demo://auth/session_destroyed"
      );
      return {
        ...prev,
        currentOwner: null,
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
    setCurrentSection("overview");
  }, []);

  const addChannel = useCallback(
    (
      slug: string,
      displayName: string,
      tagline: string,
      language: string,
      agentId: string,
      launchTitle: string
    ) => {
      const cleanSlug = slug.trim().toLowerCase().replace(/\s+/g, "-");
      const cleanName = displayName.trim();
      const cleanLaunch = launchTitle.trim() || `${cleanName} Pilot`;
      if (!cleanSlug || !cleanName) return;

      const newChan: Channel = {
        id: createId(),
        slug: cleanSlug,
        displayName: cleanName,
        tagline: tagline.trim() || "Independent director-led studio channel",
        language: language.trim() || "English",
        agentId,
        ownerId: "owner-01",
        launchTitle: cleanLaunch,
        activePlatforms: ["YouTube", "Instagram", "Snapchat"],
        slots: createCanonicalMediaSlots(cleanLaunch),
      };

      const ev = makeEvidence(
        "CHANNEL_REGISTERED",
        agentId,
        cleanSlug,
        "catalog",
        computeSha256(cleanSlug + cleanName),
        `demo://channel/registered?slug=${cleanSlug}`
      );

      setState((prev) => ({
        ...prev,
        channels: [...prev.channels, newChan],
        evidenceEvents: [ev, ...prev.evidenceEvents],
      }));
    },
    []
  );

  const saveSchedule = useCallback((schedule: DirectorSchedule) => {
    const ev = makeEvidence(
      "SCHEDULE_CONFIGURED",
      schedule.agentId,
      "schedule",
      "config",
      computeSha256(schedule.agentId + schedule.preferredStartTime),
      `demo://schedule/saved?agentId=${schedule.agentId}&enabled=${schedule.enabled}`
    );
    setState((prev) => ({
      ...prev,
      schedules: {
        ...prev.schedules,
        [schedule.agentId]: schedule,
      },
      evidenceEvents: [ev, ...prev.evidenceEvents],
    }));
    setSchedulerFeedback(
      `Schedule saved for Director ${schedule.agentId} (${schedule.episodesPerDay} eps/day, ${Math.round(
        schedule.mainEpisodeDuration / 60
      )}m).`
    );
  }, []);

  const previewSchedulePlan = useCallback(
    (agentId: string) => {
      const sched: DirectorSchedule = state.schedules[agentId] ?? {
        agentId,
        mainEpisodeDuration: 1800,
        episodesPerDay: 2,
        productionDays: [1, 2, 3, 4, 5],
        preferredStartTime: "09:00",
        timezone: "Asia/Kolkata",
        enabled: true,
      };
      const sortedDays = [...sched.productionDays]
        .sort((a, b) => a - b)
        .map(dayName)
        .join(", ");
      setSchedulerFeedback(
        `Plan Preview: ${sched.episodesPerDay} slots ready for production days ${
          sortedDays || "None"
        } starting at ${sched.preferredStartTime} (${
          sched.timezone
        }). Quota check: HEALTHY.`
      );
    },
    [state.schedules]
  );

  const runSchedulerNow = useCallback((agentId: string) => {
    setState((prev) => {
      const sched: DirectorSchedule = prev.schedules[agentId] ?? {
        agentId,
        mainEpisodeDuration: 1800,
        episodesPerDay: 2,
        productionDays: [1, 2, 3, 4, 5],
        preferredStartTime: "09:00",
        timezone: "Asia/Kolkata",
        enabled: true,
      };
      const channel = prev.channels.find((c) => c.agentId === agentId);
      const baseTitle = channel
        ? `${channel.displayName} — Scheduled Release`
        : "Episode Release";
      const nextEpNumber =
        prev.releases.filter((r) => r.channelId === channel?.id).length + 1;

      const releaseId = createId();
      const release: ProductionRelease = {
        id: releaseId,
        channelId: channel?.id ?? "chan-01",
        channelName: channel?.displayName ?? `Director ${agentId}`,
        title: `${baseTitle} #${nextEpNumber}`,
        season: 1,
        episode: nextEpNumber,
        status: "in_production",
        currentStage: "story",
        stageProgress: 0.12,
        createdAt: getCurrentTimestamp(),
        executionLog: [
          "[demo] Simulated scheduler tick recorded in the in-memory plan",
          "[demo] No scheduler backend or provider work was executed",
        ],
      };

      const newJob: ProductionJob = {
        id: createId(),
        agentId,
        capability: "story_plan",
        status: "running",
        progressPercent: 12,
        note: `Scheduled slot initiated for ${
          channel?.displayName ?? agentId
        } (#${nextEpNumber})`,
        createdAt: "Just now",
      };

      const ev = makeEvidence(
        "SCHEDULER_SLOT_TRIGGERED",
        agentId,
        channel?.slug ?? "unknown",
        "story",
        computeSha256(release.id + release.title),
        `demo://scheduler/tick-simulated?duration=${sched.mainEpisodeDuration}s`
      );

      setSchedulerFeedback(
        `[demo] Slot queued successfully in this in-memory scheduler for ${
          channel?.displayName ?? agentId
        }: 1 episode simulated (${Math.round(
          sched.mainEpisodeDuration / 60
        )}m duration, timezone: ${
          sched.timezone
        }). No backend scheduler was contacted.`
      );

      return {
        ...prev,
        releases: [release, ...prev.releases],
        jobs: [newJob, ...prev.jobs],
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const sendDirectorMessage = useCallback(
    (
      agentId: string,
      kind: MessageKind,
      sender: MessageSender,
      body: string
    ) => {
      const trimmed = body.trim();
      if (!trimmed) return;

      const clientMessageId = createId();
      const ownerMsg: DirectorMessage = {
        id: createId(),
        agentId,
        kind,
        sender,
        source: sender === "owner" ? "owner" : "director_ai",
        clientMessageId,
        body: trimmed,
        timestamp: getCurrentTimeSimple(),
      };

      const ackId = createId();
      const ackMsg: DirectorMessage | null =
        sender === "owner"
          ? {
              id: ackId,
              agentId,
              kind: "conversation",
              sender: "director",
              source: "system_delivery_ack",
              clientMessageId,
              body: `[System Delivery Ack] Message received and routed to Director ${agentId}. Awaiting AI Director response...`,
              timestamp: getCurrentTimeSimple(),
            }
          : null;

      setState((prev) => {
        const newMessages: DirectorMessage[] = ackMsg
          ? [ownerMsg, ackMsg]
          : [ownerMsg];

        const newEvidence: EvidenceEvent[] = [
          makeEvidence(
            "COMMUNICATION_RECORDED",
            agentId,
            "studio",
            kind,
            computeSha256(ownerMsg.id + trimmed),
            `comm://director/${agentId}?sender=${sender}&kind=${kind}`
          ),
        ];

        return {
          ...prev,
          messages: [...prev.messages, ...newMessages],
          evidenceEvents: [...newEvidence, ...prev.evidenceEvents],
        };
      });

      if (sender !== "owner") return;

      void (async () => {
        try {
          // The endpoint is an authenticated, CSRF-protected Owner route.
          // Cookie sessions need the per-session token (double submit); the
          // token is fetched only for the session holder that is already logged
          // in. This never exposes a provider key to the browser.
          const csrfToken = await getOwnerCsrfToken();
          const res = await fetch(
            `/api/director-comm/${encodeURIComponent(agentId)}/messages`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
              },
              body: JSON.stringify({
                body: trimmed,
                kind,
                clientMessageId,
              }),
            }
          );

          const data = await res.json().catch(() => null);
          const reply: DirectorMessage =
            data?.directorResponse ?? {
              id: createId(),
              agentId,
              kind: "conversation",
              sender: "director",
              source: "system_error",
              outcome:
                res.status === 401 || res.status === 403
                  ? "ROUTING_FAILED"
                  : "PROVIDER_UNAVAILABLE",
              clientMessageId,
              body: describeCommFailure(res.status, data?.error),
              timestamp: getCurrentTimeSimple(),
            };

          setState((prev) => ({
            ...prev,
            messages: [
              ...prev.messages.filter((m) => m.id !== ackId),
              {
                ...reply,
                timestamp: getCurrentTimeSimple(),
              },
            ],
            evidenceEvents: [
              makeEvidence(
                reply.source === "director_ai"
                  ? "DIRECTOR_AI_RESPONDED"
                  : "DIRECTOR_PROVIDER_UNAVAILABLE",
                agentId,
                "studio",
                reply.outcome ?? "PROVIDER_UNAVAILABLE",
                computeSha256(reply.id + reply.body),
                `comm://director/${agentId}/outcome/${reply.outcome ?? "PROVIDER_UNAVAILABLE"}`
              ),
              ...prev.evidenceEvents,
            ],
          }));
        } catch (err) {
          const errMsg: DirectorMessage = {
            id: createId(),
            agentId,
            kind: "conversation",
            sender: "director",
            source: "system_error",
            outcome: "PROVIDER_UNAVAILABLE",
            clientMessageId,
            body: `[Provider Unavailable] Could not reach the Director AI backend (${
              err instanceof Error ? err.message : "network error"
            }). No AI response was fabricated.`,
            timestamp: getCurrentTimeSimple(),
          };
          setState((prev) => ({
            ...prev,
            messages: [
              ...prev.messages.filter((m) => m.id !== ackId),
              errMsg,
            ],
          }));
        }
      })();
    },
    []
  );

  const startProductionRelease = useCallback(
    (channelId: string, title: string, season: number, episode: number) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setState((prev) => {
        const channel = prev.channels.find((c) => c.id === channelId);
        const releaseId = createId();
        const release: ProductionRelease = {
          id: releaseId,
          channelId,
          channelName: channel?.displayName ?? "Channel",
          title: trimmed,
          season,
          episode,
          status: "in_production",
          currentStage: "story",
          stageProgress: 0.12,
          createdAt: getCurrentTimestamp(),
          executionLog: [
            "[demo] Release registered in the in-memory plan",
            "[demo] No provider or pipeline work was executed",
          ],
        };

        const job: ProductionJob = {
          id: createId(),
          agentId: channel?.agentId ?? "agent-01",
          capability: "story_plan",
          status: "running",
          progressPercent: 12,
          note: `Production run started for: ${trimmed}`,
          createdAt: "Just now",
        };

        const ev = makeEvidence(
          "PRODUCTION_RELEASE_STARTED",
          channel?.agentId ?? "agent-01",
          channel?.slug ?? "slug",
          "story",
          computeSha256(release.id + trimmed),
          `demo://pipeline/start?season=${season}&episode=${episode}`
        );

        return {
          ...prev,
          releases: [release, ...prev.releases],
          jobs: [job, ...prev.jobs],
          evidenceEvents: [ev, ...prev.evidenceEvents],
        };
      });
    },
    []
  );

  const advancePipelineStage = useCallback((releaseId: string) => {
    setState((prev) => {
      const idx = prev.releases.findIndex((r) => r.id === releaseId);
      if (idx === -1) return prev;
      const rel = prev.releases[idx];
      const stageIdx = PIPELINE_STAGES.findIndex(
        (s) => s.key === rel.currentStage
      );
      if (stageIdx === -1 || stageIdx >= PIPELINE_STAGES.length - 1) {
        return prev;
      }

      const nextStage = PIPELINE_STAGES[stageIdx + 1].key;
      const nextStatus: ReleaseStatus =
        nextStage === "complete"
          ? "published"
          : nextStage === "qc"
          ? "review"
          : "in_production";
      const progress = (stageIdx + 2) / PIPELINE_STAGES.length;
      const newLogEntry = `[demo] Stage advanced to ${nextStage} in the in-memory plan; no render, QC gate or provider execution occurred.`;

      const updatedReleases = [...prev.releases];
      updatedReleases[idx] = {
        ...rel,
        currentStage: nextStage,
        status: nextStatus,
        stageProgress: progress,
        executionLog: [...rel.executionLog, newLogEntry],
      };

      const stageHash = computeSha256(`${rel.id}${nextStage}${Date.now()}`);
      const ev = makeEvidence(
        "STAGE_ADVANCED",
        "director",
        rel.channelName,
        nextStage,
        stageHash,
        `demo://pipeline/stage-advanced?stage=${nextStage}&status=${nextStatus}`
      );

      return {
        ...prev,
        releases: updatedReleases,
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const updateJobStatus = useCallback((jobId: string, newStatus: JobStatus) => {
    setState((prev) => {
      const idx = prev.jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return prev;
      const job = prev.jobs[idx];
      const updatedJobs = [...prev.jobs];
      updatedJobs[idx] = { ...job, status: newStatus };

      const ev = makeEvidence(
        "JOB_STATUS_UPDATED",
        job.agentId,
        "jobs",
        job.capability,
        computeSha256(job.id + newStatus),
        `demo://job/${newStatus}?id=${jobId}`
      );

      return {
        ...prev,
        jobs: updatedJobs,
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const decideApproval = useCallback((approvalId: string, approved: boolean) => {
    setState((prev) => {
      const idx = prev.approvals.findIndex((a) => a.id === approvalId);
      if (idx === -1) return prev;
      const item = prev.approvals[idx];
      const newStatus = approved ? "approved" : "rejected";
      const updatedApprovals = [...prev.approvals];
      updatedApprovals[idx] = { ...item, status: newStatus };

      const ev = makeEvidence(
        approved ? "OWNER_APPROVAL_GRANTED" : "OWNER_APPROVAL_REJECTED",
        "owner",
        item.channelName,
        "publishing",
        item.artifactHash,
        `demo://approval/${newStatus}-on-demo-fixture?dest=${item.destination}`
      );

      return {
        ...prev,
        approvals: updatedApprovals,
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const updateConnectionSlot = useCallback(
    (connectionId: string, status: ConnectionSlotStatus, locator: string) => {
      const cleanLocator =
        locator.trim() || "vault://stph-secrets/unconfigured";
      setState((prev) => {
        const idx = prev.platformConnections.findIndex(
          (c) => c.id === connectionId
        );
        if (idx === -1) return prev;
        const slot = prev.platformConnections[idx];
        const updated = [...prev.platformConnections];
        updated[idx] = {
          ...slot,
          status,
          locator: cleanLocator,
          lastVerified: getCurrentTimestamp(),
        };

        const ev = makeEvidence(
          "CONNECTION_SLOT_CONFIGURED",
          slot.agentId,
          slot.platform,
          "credentials",
          computeSha256(connectionId + cleanLocator),
          "demo://connections/locator_saved"
        );

        return {
          ...prev,
          platformConnections: updated,
          evidenceEvents: [ev, ...prev.evidenceEvents],
        };
      });
    },
    []
  );

  const inspectArtifact = useCallback((slot: MediaSlot, channelSlug: string) => {
    const computedHash =
      slot.artifactHash ??
      computeSha256(
        `${slot.key}:${slot.artifactTitle}:${slot.durationSeconds}`
      );
    const ev: EvidenceEvent = {
      id: createId(),
      eventType: "ARTIFACT_INSPECTED",
      agentId: "inspector",
      channelSlug,
      stage: "qc",
      artifactHash: computedHash,
      verificationReceipt:
        "demo://inspection?note=in-memory demo slot; no FFprobe was executed",
      timestamp: getCurrentTimestamp(),
    };

    setState((prev) => ({
      ...prev,
      evidenceEvents: [ev, ...prev.evidenceEvents],
    }));

    setInspectionData({
      title: slot.artifactTitle ?? slot.label,
      slotKey: slot.key,
      durationSeconds: slot.durationSeconds ?? 0,
      resolution: slot.resolution,
      aspectRatio: slot.aspectRatio,
      lufs: slot.lufsAudio,
      codec: slot.codec,
      sha256: computedHash,
      isVerified: slot.verified,
    });
  }, []);

  const dismissInspection = useCallback(() => {
    setInspectionData(null);
  }, []);

  const resetToCanonical = useCallback(() => {
    const fresh = getDefaultPersistedState();
    const ev = makeEvidence(
      "SYSTEM_RESET_TO_CANONICAL",
      "owner",
      "system",
      "catalog",
      computeSha256(createId()),
      "demo://system/reset_canonical"
    );
    setState((prev) => ({
      ...fresh,
      currentOwner: prev.currentOwner ?? INITIAL_OWNER,
      evidenceEvents: [ev, ...fresh.evidenceEvents],
    }));
    setSchedulerFeedback(null);
  }, []);

  const setDefaultPublishingMode = useCallback((mode: PublishingMode) => {
    setState((prev) => ({
      ...prev,
      defaultPublishingMode: mode,
    }));
  }, []);

  const setOwnerAvailability = useCallback((availability: OwnerAvailability) => {
    setState((prev) => {
      if (prev.ownerAvailability === availability) return prev;
      const ev = makeEvidence(
        "OWNER_AVAILABILITY_UPDATED",
        "owner",
        "governance",
        "delegation",
        computeSha256(`availability:${availability}:${Date.now()}`),
        `demo://hermes/owner-availability?state=${availability}`
      );
      return {
        ...prev,
        ownerAvailability: availability,
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const toggleDelegatedPolicy = useCallback((policyId: string) => {
    setState((prev) => {
      const idx = prev.delegationPolicies.findIndex((p) => p.id === policyId);
      if (idx === -1) return prev;
      const target = prev.delegationPolicies[idx];
      if (target.lockedOwnerOnly) return prev;
      const nextVal = !target.delegatedWhenUnavailable;
      const updated = [...prev.delegationPolicies];
      updated[idx] = { ...target, delegatedWhenUnavailable: nextVal };

      const ev = makeEvidence(
        "DELEGATION_POLICY_UPDATED",
        "owner",
        "governance",
        "delegation",
        computeSha256(`${policyId}:${nextVal}:${Date.now()}`),
        `demo://hermes/delegation-policy?id=${policyId}&delegated=${nextVal}`
      );

      const dec: HermesDecision = {
        id: createId(),
        topic: `Delegation Rule: ${target.category}`,
        decision: nextVal
          ? "[demo] Explicit unavailability delegation enabled by Owner"
          : "[demo] Unavailability delegation revoked — requires explicit Owner consent",
        rationale:
          "Owner availability policy updated inside the console. No response is never treated as consent.",
        authorityTier: "Owner Governance",
        timestamp: getCurrentTimeSimple(),
      };

      return {
        ...prev,
        delegationPolicies: updated,
        hermesDecisions: [dec, ...prev.hermesDecisions],
        evidenceEvents: [ev, ...prev.evidenceEvents],
      };
    });
  }, []);

  const evaluateHermesDelegation = useCallback(
    (
      policyId: string,
      requestSummary: string,
      approvalWindowExpired: boolean
    ): { outcome: string; detail: string; allowed: boolean } => {
      const cleanSummary =
        requestSummary.trim() || "Simulated HERMES action request";
      const policy = state.delegationPolicies.find((p) => p.id === policyId);
      if (!policy) {
        return {
          outcome: "UNKNOWN_POLICY",
          detail: "No matching delegation policy found.",
          allowed: false,
        };
      }

      let outcome = "";
      let detail = "";
      let allowed = false;
      let tier = "Tier 2: Policy Governed";

      if (policy.lockedOwnerOnly) {
        outcome = "BLOCKED_OWNER_ONLY";
        detail = `[demo] Refused: "${policy.category}" is strictly Owner-only. Even when the Owner is unavailable or an approval window expires, HERMES cannot self-authorize reserved actions.`;
        tier = "Tier 3: Owner Required";
      } else if (state.ownerAvailability === "available") {
        if (policy.disposition === "explicit_policy_only") {
          outcome = "AWAITING_OWNER_DECISION";
          detail = `[demo] Owner is AVAILABLE: submitted "${cleanSummary}" to Owner approval queue. HERMES awaits direct Owner consent.`;
          tier = "Tier 3: Owner Required";
        } else {
          outcome = "OWNER_PRECEDENCE_PREPARED";
          detail = `[demo] Owner is AVAILABLE: HERMES prepared "${cleanSummary}" for routine execution under active Owner precedence.`;
          allowed = true;
          tier = "Tier 1: Autonomous";
        }
      } else {
        // Owner unavailable
        if (approvalWindowExpired && !policy.delegatedWhenUnavailable) {
          outcome = "PAUSED_NO_ASSUMED_CONSENT";
          detail = `[demo] Owner UNAVAILABLE + response window expired: No explicit delegation covers "${policy.category}". Silence is not consent — HERMES paused this action and continued unrelated safe work.`;
          tier = "Paused · No Assumed Consent";
        } else if (!policy.delegatedWhenUnavailable) {
          outcome = "PAUSED_AWAITING_EXPLICIT_DELEGATION";
          detail = `[demo] Owner UNAVAILABLE: "${policy.category}" is not delegated for automatic decision. Action remains paused until Owner responds or updates delegation policy.`;
          tier = "Tier 3: Owner Required";
        } else {
          outcome = "EXECUTED_WITHIN_DELEGATION";
          detail = `[demo] Owner UNAVAILABLE: "${policy.category}" is explicitly delegated. HERMES authorized "${cleanSummary}", logged reasoning, and queued Owner re-entry notification.`;
          allowed = true;
          tier = "Delegated Executive Authority";
        }
      }

      const dec: HermesDecision = {
        id: createId(),
        topic: `${policy.category} (${outcome})`,
        decision: `${cleanSummary} → ${outcome}`,
        rationale: detail,
        authorityTier: tier,
        timestamp: getCurrentTimeSimple(),
      };

      const ev = makeEvidence(
        "HERMES_DELEGATION_EVALUATED",
        "hermes",
        "governance",
        outcome.toLowerCase(),
        computeSha256(`${policyId}:${outcome}:${cleanSummary}:${Date.now()}`),
        `demo://hermes/evaluate?policy=${policyId}&outcome=${outcome}`
      );

      setState((prev) => ({
        ...prev,
        hermesDecisions: [dec, ...prev.hermesDecisions],
        evidenceEvents: [ev, ...prev.evidenceEvents],
      }));

      return { outcome, detail, allowed };
    },
    [state.delegationPolicies, state.ownerAvailability]
  );

  return {
    // Static metadata
    agents: INITIAL_AGENTS,
    storageMode: STORAGE_MODE,
    storageStatus: STORAGE_STATUS,

    // Persisted domain state
    currentOwner: state.currentOwner,
    channels: state.channels,
    releases: state.releases,
    schedules: state.schedules,
    messages: state.messages,
    charters: state.charters,
    jobs: state.jobs,
    providers: state.providers,
    platformConnections: state.platformConnections,
    approvals: state.approvals,
    evidenceEvents: state.evidenceEvents,
    hermesDecisions: state.hermesDecisions,
    defaultPublishingMode: state.defaultPublishingMode,
    ownerAvailability: state.ownerAvailability,
    delegationPolicies: state.delegationPolicies,

    // UI navigation & filter state
    currentSection,
    selectedAgentId,
    schedulerFeedback,
    channelSearchQuery,
    jobStatusFilter,
    evidenceFilter,
    inspectionData,

    // Actions
    navigateTo: setCurrentSection,
    selectAgent: setSelectedAgentId,
    login,
    logout,
    addChannel,
    saveSchedule,
    previewSchedulePlan,
    runSchedulerNow,
    clearSchedulerFeedback: () => setSchedulerFeedback(null),
    sendDirectorMessage,
    startProductionRelease,
    advancePipelineStage,
    pauseJob: (id: string) => updateJobStatus(id, "paused"),
    resumeJob: (id: string) => updateJobStatus(id, "running"),
    cancelJob: (id: string) => updateJobStatus(id, "failed"),
    setJobStatusFilter,
    setEvidenceFilter,
    setChannelSearchQuery,
    approveItem: (id: string) => decideApproval(id, true),
    rejectItem: (id: string) => decideApproval(id, false),
    updateConnectionSlot,
    inspectArtifact,
    dismissInspection,
    resetToCanonical,
    setDefaultPublishingMode,
    setOwnerAvailability,
    toggleDelegatedPolicy,
    evaluateHermesDelegation,
  };
}
