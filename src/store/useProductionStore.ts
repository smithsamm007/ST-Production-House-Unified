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
import {
  ApprovalItem,
  Channel,
  ConnectionSlotStatus,
  CreativeCharter,
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
    };
  } catch {
    return getDefaultPersistedState();
  }
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

      setState((prev) => {
        const msg: DirectorMessage = {
          id: createId(),
          agentId,
          kind,
          sender,
          body: trimmed,
          timestamp: getCurrentTimeSimple(),
        };
        const newMessages: DirectorMessage[] = [msg];
        const newEvidence: EvidenceEvent[] = [
          makeEvidence(
            "COMMUNICATION_RECORDED",
            agentId,
            "studio",
            kind,
            computeSha256(msg.id + trimmed),
            `demo://communication/logged?sender=${sender}&kind=${kind}`
          ),
        ];

        if (sender === "owner" && (kind === "instruction" || kind === "proposal")) {
          const charter = prev.charters[agentId];
          const replyKind: MessageKind =
            kind === "instruction" ? "decision" : "proposal";
          const replyBody =
            kind === "instruction"
              ? `[demo simulated reply] Confirmed. Aligning scene pacing and audio loudness to charter guidelines (${
                  charter?.pacing ?? "cinematic rhythm"
                }).`
              : "[demo simulated reply] Evaluated proposal against continuity rules. Ready to generate 3 alternative visual scene variations for review.";

          const replyMsg: DirectorMessage = {
            id: createId(),
            agentId,
            kind: replyKind,
            sender: "director",
            body: replyBody,
            timestamp: getCurrentTimeSimple(),
          };
          newMessages.push(replyMsg);
          newEvidence.unshift(
            makeEvidence(
              "DIRECTOR_REPLY_RECORDED",
              agentId,
              "studio",
              replyKind,
              computeSha256(replyMsg.id + replyBody),
              "demo://communication/simulated_reply"
            )
          );
        }

        return {
          ...prev,
          messages: [...prev.messages, ...newMessages],
          evidenceEvents: [...newEvidence, ...prev.evidenceEvents],
        };
      });
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
  };
}
