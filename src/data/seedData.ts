import {
  Agent,
  ApprovalItem,
  Channel,
  CreativeCharter,
  DirectorMessage,
  DirectorSchedule,
  EvidenceEvent,
  HermesDecision,
  MediaSlot,
  Owner,
  PlatformConnection,
  ProductionJob,
  ProductionRelease,
  ProviderSlot,
} from "../types/models";
import { computeSha256, createId } from "../utils/crypto";

export const STORAGE_MODE = "local-device";
export const STORAGE_STATUS = "healthy";

export function createCanonicalMediaSlots(launchTitle: string): MediaSlot[] {
  return [
    {
      key: "main_video",
      label: "Main Video",
      hint: "longform episode",
      status: "planned",
      artifactTitle: launchTitle,
      durationSeconds: 1800,
      artifactHash: null,
      verified: false,
      resolution: "1920x1080",
      aspectRatio: "16:9",
      lufsAudio: "demo plan",
      codec: "demo plan",
    },
    {
      key: "content_reel_1",
      label: "Short 1",
      hint: "content reel",
      status: "planned",
      artifactTitle: `${launchTitle} (Highlight A)`,
      durationSeconds: 45,
      artifactHash: null,
      verified: false,
      resolution: "1080x1920",
      aspectRatio: "9:16",
      lufsAudio: "demo plan",
      codec: "demo plan",
    },
    {
      key: "content_reel_2",
      label: "Short 2",
      hint: "content reel",
      status: "planned",
      artifactTitle: `${launchTitle} (Highlight B)`,
      durationSeconds: 50,
      artifactHash: null,
      verified: false,
      resolution: "1080x1920",
      aspectRatio: "9:16",
      lufsAudio: "demo plan",
      codec: "demo plan",
    },
    {
      key: "brand_reel",
      label: "Brand Reel",
      hint: "standalone brand promo",
      status: "planned",
      artifactTitle: "Studio Identity Promo",
      durationSeconds: 30,
      artifactHash: null,
      verified: false,
      resolution: "1080x1920",
      aspectRatio: "9:16",
      lufsAudio: "demo plan",
      codec: "demo plan",
    },
  ];
}

export const INITIAL_OWNER: Owner = {
  id: "owner-01",
  email: "owner@stproduction.demo",
  role: "owner",
  isAuthenticated: true,
};

const SEEDED_AGENT_NAMES = [
  "JARVIS",
  "SHERLOCK",
  "LAKME",
  "PANCHI",
  "VEDA",
  "BYTE",
  "CHANAKYA",
  "KABIR",
  "SHAKTI",
  "ROHAN",
  "MAYA",
  "AAROHI",
  "VIKRAM",
  "TARA",
  "ANANYA",
  "KARAN",
  "DEV",
  "AANYA",
  "ARJUN",
  "NISHA",
  "NEWTON",
];

// Rule 15: Internal agent names stay strictly server-side / internal and never render on public channel surfaces.
export const INITIAL_AGENTS: Agent[] = SEEDED_AGENT_NAMES.map((name, index) => ({
  id: `agent-${String(index + 1).padStart(2, "0")}`,
  name,
  namespace: `st.agent.${name.toLowerCase()}`,
  enabled: true,
}));

export function getInitialChannels(): Channel[] {
  return [
    {
      id: "chan-01",
      slug: "midnight-horror-hindi",
      displayName: "Midnight Horror Studios",
      tagline: "Connected horror cinematic universe — Hindi & Hinglish",
      language: "Hindi / Hinglish",
      agentId: "agent-01",
      ownerId: "owner-01",
      launchTitle: "Nightfall Ward 7 — Pilot",
      activePlatforms: ["YouTube", "Instagram", "Snapchat"],
      slots: createCanonicalMediaSlots("Nightfall Ward 7 — Pilot"),
    },
    {
      id: "chan-02",
      slug: "mythology-epics",
      displayName: "Epic Mythology Labs",
      tagline: "Hindu mythology epics with narrator-led storytelling",
      language: "Hindi",
      agentId: "agent-03",
      ownerId: "owner-01",
      launchTitle: "Samay Ke Paar — Season 1 Premiere",
      activePlatforms: ["YouTube", "Instagram", "Snapchat"],
      slots: createCanonicalMediaSlots("Samay Ke Paar — Season 1 Premiere"),
    },
    {
      id: "chan-03",
      slug: "detective-anime",
      displayName: "Case Notes Anime",
      tagline: "Detective drama shorts, weekly cadence",
      language: "Hinglish",
      agentId: "agent-02",
      ownerId: "owner-01",
      launchTitle: "The Alibi Engine — Case 001",
      activePlatforms: ["YouTube", "Instagram", "Snapchat"],
      slots: createCanonicalMediaSlots("The Alibi Engine — Case 001"),
    },
    {
      id: "chan-04",
      slug: "science-explainers",
      displayName: "Newton Explains",
      tagline: "Science & engineering explainers for young viewers",
      language: "English",
      agentId: "agent-21",
      ownerId: "owner-01",
      launchTitle: "Why Bridges Sing — Ep 1",
      activePlatforms: ["YouTube", "Instagram", "Snapchat"],
      slots: createCanonicalMediaSlots("Why Bridges Sing — Ep 1"),
    },
  ];
}

export function getInitialReleases(): ProductionRelease[] {
  return [
    {
      id: "rel-01",
      channelId: "chan-01",
      channelName: "Midnight Horror Studios",
      title: "Nightfall Ward 7: The Corridor Echo",
      season: 1,
      episode: 2,
      status: "in_production",
      currentStage: "visual",
      stageProgress: 0.65,
      createdAt: "Today, 10:45 AM",
      executionLog: [
        "[demo fixture] Story beats listed as a production plan",
        "[demo fixture] No visual, TTS, render or QC work has executed",
      ],
    },
    {
      id: "rel-02",
      channelId: "chan-02",
      channelName: "Epic Mythology Labs",
      title: "Samay Ke Paar: The Cosmic Wheel",
      season: 1,
      episode: 1,
      status: "review",
      currentStage: "qc",
      stageProgress: 0.95,
      createdAt: "Today, 08:30 AM",
      executionLog: [
        "[demo fixture] Story beats listed as a production plan",
        "[demo fixture] No visual, TTS, render or QC work has executed",
      ],
    },
    {
      id: "rel-03",
      channelId: "chan-03",
      channelName: "Case Notes Anime",
      title: "The Alibi Engine: Missing Ledger",
      season: 1,
      episode: 3,
      status: "rendering",
      currentStage: "assembly",
      stageProgress: 0.42,
      createdAt: "Today, 09:15 AM",
      executionLog: [
        "[demo fixture] Story beats listed as a production plan",
        "[demo fixture] No visual, TTS, render or QC work has executed",
      ],
    },
  ];
}

export function getInitialSchedules(): Record<string, DirectorSchedule> {
  return {
    "agent-01": {
      agentId: "agent-01",
      mainEpisodeDuration: 1800,
      episodesPerDay: 2,
      productionDays: [1, 2, 3, 4, 5],
      preferredStartTime: "09:00",
      timezone: "Asia/Kolkata",
      enabled: true,
    },
    "agent-02": {
      agentId: "agent-02",
      mainEpisodeDuration: 1800,
      episodesPerDay: 1,
      productionDays: [1, 3, 5],
      preferredStartTime: "14:00",
      timezone: "Asia/Kolkata",
      enabled: true,
    },
    "agent-03": {
      agentId: "agent-03",
      mainEpisodeDuration: 2400,
      episodesPerDay: 1,
      productionDays: [2, 4, 6],
      preferredStartTime: "10:30",
      timezone: "Asia/Kolkata",
      enabled: true,
    },
    "agent-21": {
      agentId: "agent-21",
      mainEpisodeDuration: 1800,
      episodesPerDay: 3,
      productionDays: [1, 2, 3, 4, 5, 6, 7],
      preferredStartTime: "08:00",
      timezone: "UTC",
      enabled: true,
    },
  };
}

export function getInitialMessages(): DirectorMessage[] {
  return [
    {
      id: "msg-01",
      agentId: "agent-01",
      kind: "instruction",
      sender: "owner",
      body: "Keep the audio mix grounded; avoid high-pass clipping on the ambient corridor drone.",
      timestamp: "10:15 AM",
    },
    {
      id: "msg-02",
      agentId: "agent-01",
      kind: "proposal",
      sender: "director",
      body: "Generated 4 candidate visual styles for scene 4B. Recommending the shadow-silhouette treatment.",
      timestamp: "10:22 AM",
    },
    {
      id: "msg-03",
      agentId: "agent-01",
      kind: "decision",
      sender: "owner",
      body: "Shadow-silhouette approved. Proceed to Narration pass.",
      timestamp: "10:28 AM",
    },
    {
      id: "msg-04",
      agentId: "agent-03",
      kind: "conversation",
      sender: "director",
      body: "Episode 2 script beats align with the Vishnu Purana references from the charter.",
      timestamp: "09:00 AM",
    },
  ];
}

export function getInitialCharters(): Record<string, CreativeCharter> {
  return {
    "agent-01": {
      agentId: "agent-01",
      logline:
        "An abandoned sanatorium holds temporal echoes of forgotten medical anomalies.",
      premise:
        "A gritty investigative universe set across northern Indian psychiatric ruins where audio phenomena precede spatial tears.",
      visualStyle:
        "Atmospheric dark cyan, cold rim lights, high contrast grain, claustrophobic corridors.",
      pacing:
        "Slow-burn tension building to rapid kinetic climax in final 5 minutes.",
      targetAudience:
        "Young adults (18-35) horror & psychological thriller fans.",
      continuityRules: [
        "Rule 1: Time fluctuations are always accompanied by 60Hz hum.",
        "Rule 2: Ward 7 layout is mathematically non-Euclidean.",
        "Rule 3: Characters never split up after twilight.",
      ],
    },
    "agent-03": {
      agentId: "agent-03",
      logline:
        "Ancient cosmic timelines converge through celestial heralds of truth.",
      premise:
        "Grand mythological epics adapted with fidelity to Sanskrit literature and cinematic soundscapes.",
      visualStyle:
        "Vibrant saffron and gold illumination, celestial nebulae, detailed temple architecture.",
      pacing:
        "Epic cadence, ceremonial grandeur, measured poetic narration.",
      targetAudience: "General public & mythology enthusiasts worldwide.",
      continuityRules: [
        "Rule 1: Cosmic weapons have irreversible collateral oaths.",
        "Rule 2: Deities speak in elevated formal Sanskrit-derived vocabulary.",
        "Rule 3: Solar and lunar alignments strictly govern celestial interventions.",
      ],
    },
    "agent-02": {
      agentId: "agent-02",
      logline:
        "A forensic algorithm specialist uncovers fabricated alibis in high-stakes cyber crimes.",
      premise:
        "Fast-paced deductive detective procedural combining classic deductive mystery with modern automated evidence inspection.",
      visualStyle:
        "Sharp neon accents, monochrome backgrounds, graphic anime cuts and deduction diagrams.",
      pacing: "Rapid episodic pacing, 3 clues per beat, cliffhanger every act.",
      targetAudience: "Anime & detective mystery audience.",
      continuityRules: [
        "Rule 1: Every clue shown must be solvable by the audience.",
        "Rule 2: Digital forensics must adhere to honest hashing (SHA-256).",
        "Rule 3: No unexplainable supernatural elements.",
      ],
    },
    "agent-21": {
      agentId: "agent-21",
      logline:
        "Breaking down advanced physics and engineering wonders into delightful anime visual metaphors.",
      premise:
        "Clear, joyful explanations of how the physical world works, inspired by Newton's principia.",
      visualStyle:
        "Clean blueprint aesthetic, vibrant chalk overlays, warm daylight lighting.",
      pacing: "Energetic, educational, upbeat.",
      targetAudience:
        "Students, curious adults, engineering enthusiasts.",
      continuityRules: [
        "Rule 1: Physics formulas and dimensions must be mathematically accurate.",
        "Rule 2: Real-world analogies must fail gracefully if oversimplified.",
        "Rule 3: Safety principles must be explicitly stated.",
      ],
    },
  };
}

export function getInitialJobs(): ProductionJob[] {
  return [
    {
      id: "job-101",
      agentId: "agent-01",
      capability: "visual_scene_plan",
      status: "running",
      progressPercent: 65,
      note: "[demo fixture] simulated visual job; no images have generated",
      createdAt: "Just now",
    },
    {
      id: "job-102",
      agentId: "agent-01",
      capability: "story_plan",
      status: "queued",
      progressPercent: 0,
      note: "Pilot episode revised story beats",
      createdAt: "Just now",
    },
    {
      id: "job-103",
      agentId: "agent-03",
      capability: "narration_plan",
      status: "succeeded",
      progressPercent: 100,
      note: "[demo fixture] simulated narration job; no TTS has executed",
      createdAt: "Just now",
    },
    {
      id: "job-104",
      agentId: "agent-02",
      capability: "ffmpeg_assembly",
      status: "running",
      progressPercent: 42,
      note: "[demo fixture] simulated assembly job; no render has executed",
      createdAt: "Just now",
    },
    {
      id: "job-105",
      agentId: "agent-01",
      capability: "reel_generation",
      status: "waiting_for_quota",
      progressPercent: 15,
      note: "[demo fixture] simulated reel job; no real quota provider exists",
      createdAt: "Just now",
    },
    {
      id: "job-106",
      agentId: "agent-03",
      capability: "packaging_qc",
      status: "waiting_for_approval",
      progressPercent: 90,
      note: "[demo fixture] simulated QC job; no QC gate has executed",
      createdAt: "Just now",
    },
  ];
}

export function getInitialProviders(): ProviderSlot[] {
  return [
    {
      id: "p-01",
      name: "Pollinations Visual Engine",
      category: "Visual",
      tier: "Remote Slot 1",
      status: "healthy",
      latencyMs: 320,
      dailyQuotaUsedPercent: 45,
      cooldownSeconds: 0,
    },
    {
      id: "p-02",
      name: "Stable Diffusion SDXL Studio",
      category: "Visual",
      tier: "Remote Slot 2",
      status: "healthy",
      latencyMs: 580,
      dailyQuotaUsedPercent: 28,
      cooldownSeconds: 0,
    },
    {
      id: "p-03",
      name: "ComfyUI Worker Pipeline",
      category: "Visual",
      tier: "Remote Slot 3",
      status: "healthy",
      latencyMs: 410,
      dailyQuotaUsedPercent: 62,
      cooldownSeconds: 0,
    },
    {
      id: "p-04",
      name: "Local Ollama Emergency Node",
      category: "Visual",
      tier: "Local Emergency",
      status: "healthy",
      latencyMs: 980,
      dailyQuotaUsedPercent: 5,
      cooldownSeconds: 0,
    },
    {
      id: "p-05",
      name: "Kokoro TTS Fast Engine",
      category: "Narration",
      tier: "Remote Slot 1",
      status: "healthy",
      latencyMs: 180,
      dailyQuotaUsedPercent: 30,
      cooldownSeconds: 0,
    },
    {
      id: "p-06",
      name: "ElevenLabs Neural Voice",
      category: "Narration",
      tier: "Remote Slot 2",
      status: "healthy",
      latencyMs: 220,
      dailyQuotaUsedPercent: 70,
      cooldownSeconds: 0,
    },
    {
      id: "p-07",
      name: "Edge-TTS Multilingual",
      category: "Narration",
      tier: "Remote Slot 3",
      status: "healthy",
      latencyMs: 195,
      dailyQuotaUsedPercent: 18,
      cooldownSeconds: 0,
    },
    {
      id: "p-08",
      name: "Local Piper TTS Node",
      category: "Narration",
      tier: "Local Emergency",
      status: "healthy",
      latencyMs: 450,
      dailyQuotaUsedPercent: 0,
      cooldownSeconds: 0,
    },
    {
      id: "p-09",
      name: "FFmpeg Native Video Engine",
      category: "Assembly",
      tier: "Local Core",
      status: "healthy",
      latencyMs: 110,
      dailyQuotaUsedPercent: 52,
      cooldownSeconds: 0,
    },
    {
      id: "p-10",
      name: "YouTube Official API Publisher",
      category: "Publisher",
      tier: "Demo · unconfigured",
      status: "healthy",
      latencyMs: 250,
      dailyQuotaUsedPercent: 12,
      cooldownSeconds: 0,
    },
    {
      id: "p-11",
      name: "Meta Graph API (Instagram/FB)",
      category: "Publisher",
      tier: "Demo · unconfigured",
      status: "healthy",
      latencyMs: 310,
      dailyQuotaUsedPercent: 20,
      cooldownSeconds: 0,
    },
    {
      id: "p-12",
      name: "Snapchat Creative Kit",
      category: "Publisher",
      tier: "Demo · unconfigured",
      status: "healthy",
      latencyMs: 290,
      dailyQuotaUsedPercent: 8,
      cooldownSeconds: 0,
    },
  ];
}

export function getInitialConnections(): PlatformConnection[] {
  return [
    {
      id: "conn-01",
      agentId: "agent-01",
      platform: "YouTube",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-01/youtube-oauth",
      lastVerified: "Not configured",
    },
    {
      id: "conn-02",
      agentId: "agent-01",
      platform: "Instagram",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-01/meta-graph",
      lastVerified: "Not configured",
    },
    {
      id: "conn-03",
      agentId: "agent-01",
      platform: "Snapchat",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-01/snap-public-profile",
      lastVerified: "Not configured",
    },
    {
      id: "conn-04",
      agentId: "agent-03",
      platform: "YouTube",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-03/youtube-oauth",
      lastVerified: "Not configured",
    },
    {
      id: "conn-05",
      agentId: "agent-03",
      platform: "Instagram",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-03/meta-graph",
      lastVerified: "Not configured",
    },
    {
      id: "conn-06",
      agentId: "agent-02",
      platform: "YouTube",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-02/youtube-oauth",
      lastVerified: "Not configured",
    },
    {
      id: "conn-07",
      agentId: "agent-21",
      platform: "YouTube",
      status: "unconfigured",
      locator: "vault://stph-secrets/agent-21/youtube-oauth",
      lastVerified: "Not configured",
    },
  ];
}

export function getInitialApprovals(): ApprovalItem[] {
  return [
    {
      id: "appr-01",
      artifactHash: computeSha256("demo-fixture-appr-01"),
      channelName: "Epic Mythology Labs",
      title: "Samay Ke Paar: The Cosmic Wheel — Premiere",
      destination: "YouTube Channel (@EpicMythologyLabs)",
      caption:
        "Witness the dawn of cosmic cycles in this first chapter of Samay Ke Paar.",
      disclosure:
        "AI-assisted production using verified ST Production House pipeline.",
      affiliateLinks: "None",
      status: "pending",
      createdAt: "11:35 AM",
    },
    {
      id: "appr-02",
      artifactHash: computeSha256("demo-fixture-appr-02"),
      channelName: "Midnight Horror Studios",
      title: "Nightfall Ward 7 — Corridor Echo (Short 1)",
      destination: "Instagram Reels & YouTube Shorts",
      caption:
        "Do you hear the 60Hz hum before the door opens? #Horror #Shorts",
      disclosure: "ST Production House Studio release.",
      affiliateLinks: "None",
      status: "pending",
      createdAt: "11:38 AM",
    },
  ];
}

export function getInitialEvidence(): EvidenceEvent[] {
  return [
    {
      id: createId(),
      eventType: "DEMO_FIXTURE_QC",
      agentId: "agent-03",
      channelSlug: "mythology-epics",
      stage: "qc",
      artifactHash: computeSha256("demo-fixture-epic-qc"),
      verificationReceipt:
        "demo://fixture?note=seeded demo row; no real QC gate was executed",
      timestamp: "2026-10-17 08:25:04 UTC",
    },
    {
      id: createId(),
      eventType: "DEMO_FIXTURE_ASSEMBLY",
      agentId: "agent-02",
      channelSlug: "detective-anime",
      stage: "assembly",
      artifactHash: computeSha256("demo-fixture-anime-assembly"),
      verificationReceipt:
        "demo://fixture?note=seeded demo row; no real render was executed",
      timestamp: "2026-10-17 08:18:22 UTC",
    },
    {
      id: createId(),
      eventType: "DEMO_FIXTURE_NARRATION",
      agentId: "agent-01",
      channelSlug: "midnight-horror-hindi",
      stage: "audio",
      artifactHash: computeSha256("demo-fixture-horror-narration"),
      verificationReceipt:
        "demo://fixture?note=seeded demo row; no real TTS was executed",
      timestamp: "2026-10-17 07:55:12 UTC",
    },
  ];
}

export function getInitialHermesDecisions(): HermesDecision[] {
  return [
    {
      id: "hermes-01",
      topic: "Visual Provider Failover",
      decision: "Routing prompt batch from Slot 2 to Slot 1",
      rationale:
        "Slot 2 reported latency increase to 580ms. Slot 1 has 55% available quota.",
      authorityTier: "Tier 1: Autonomous",
      timestamp: "11:15 AM",
    },
    {
      id: "hermes-02",
      topic: "Episode Queue Prioritization",
      decision: "Promoted Epic Mythology Premiere to active render queue",
      rationale:
        "Scheduled release date in 4 hours; all prerequisite media slots verified.",
      authorityTier: "Tier 2: Policy Governed",
      timestamp: "10:30 AM",
    },
    {
      id: "hermes-03",
      topic: "Emergency Quota Cooldown Check",
      decision: "Preserved emergency local Ollama slot for night-shift fallback",
      rationale:
        "Daily remote quota is operating at healthy 38% utilization.",
      authorityTier: "Tier 1: Autonomous",
      timestamp: "09:45 AM",
    },
  ];
}
