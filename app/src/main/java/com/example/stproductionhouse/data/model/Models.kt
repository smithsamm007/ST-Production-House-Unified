package com.example.stproductionhouse.data.model

import java.util.UUID

data class Owner(
    val id: String = UUID.randomUUID().toString(),
    val email: String = "owner@stproduction.demo",
    val role: String = "owner",
    val isAuthenticated: Boolean = true
)

data class Agent(
    val id: String,
    val name: String,
    val namespace: String,
    val enabled: Boolean = true
)

data class MediaSlot(
    val key: String,
    val label: String,
    val hint: String,
    val status: String = "planned", // planned, rendering, verified, published
    val artifactTitle: String? = null,
    val durationSeconds: Int? = null,
    val artifactHash: String? = null,
    val verified: Boolean = false,
    val resolution: String = "1920x1080",
    val aspectRatio: String = "16:9",
    val lufsAudio: String = "-14.2 LUFS",
    val codec: String = "H.264 / AAC"
)

data class Channel(
    val id: String = UUID.randomUUID().toString(),
    val slug: String,
    val displayName: String,
    val tagline: String,
    val language: String,
    val agentId: String,
    val ownerId: String = "owner-01",
    val launchTitle: String,
    val activePlatforms: List<String> = listOf("YouTube", "Instagram", "Snapchat"),
    val slots: List<MediaSlot> = listOf(
        MediaSlot("main_video", "Main Video", "longform episode", "verified", launchTitle, 1800, "sha256:7f83b1657ff1a20b8e73491d90c", true, "1920x1080", "16:9", "-14.2 LUFS", "H.264 / AAC"),
        MediaSlot("content_reel_1", "Short 1", "content reel", "verified", "$launchTitle (Highlight A)", 45, "sha256:39a1c89012cd89410ea2b9187fc", true, "1080x1920", "9:16", "-14.0 LUFS", "H.264 / AAC"),
        MediaSlot("content_reel_2", "Short 2", "content reel", "planned", "$launchTitle (Highlight B)", 50, null, false, "1080x1920", "9:16", "-14.0 LUFS", "H.264 / AAC"),
        MediaSlot("brand_reel", "Brand Reel", "standalone brand promo", "verified", "Studio Identity Promo", 30, "sha256:88bc1142e09199a0b127cc9011f", true, "1080x1920", "9:16", "-13.8 LUFS", "H.264 / AAC")
    )
)

data class ProductionRelease(
    val id: String = UUID.randomUUID().toString(),
    val channelId: String,
    val channelName: String,
    val title: String,
    val season: Int,
    val episode: Int,
    val status: String = "in_production", // planned, in_production, rendering, review, published, cancelled
    val currentStage: String = "story", // story, visual, audio, assembly, reels, packaging, qc, complete
    val stageProgress: Float = 0.45f,
    val createdAt: String = "2026-10-17 08:30",
    val executionLog: List<String> = listOf(
        "Story: Beats and character arcs locked",
        "Visual: 12 keyframe scenes synthesized via Pollinations",
        "Audio: Kokoro TTS narration track generated (-14.2 LUFS)"
    )
)

data class DirectorSchedule(
    val agentId: String,
    val mainEpisodeDuration: Int = 1800, // 1800 (30m), 2400 (40m), 3000 (50m)
    val episodesPerDay: Int = 2,
    val productionDays: Set<Int> = setOf(1, 2, 3, 4, 5), // 1=Mon, 7=Sun
    val preferredStartTime: String = "09:00",
    val timezone: String = "Asia/Kolkata",
    val enabled: Boolean = true
)

data class DirectorMessage(
    val id: String = UUID.randomUUID().toString(),
    val agentId: String,
    val kind: String = "conversation", // conversation, proposal, instruction, decision
    val sender: String = "owner", // owner, director
    val body: String,
    val timestamp: String = "11:40 AM"
)

data class CreativeCharter(
    val agentId: String,
    val logline: String,
    val premise: String,
    val visualStyle: String,
    val pacing: String,
    val targetAudience: String,
    val continuityRules: List<String>
)

data class ProductionJob(
    val id: String = UUID.randomUUID().toString(),
    val agentId: String,
    val capability: String,
    val status: String, // queued, running, waiting_for_quota, waiting_for_approval, succeeded, failed, paused
    val progressPercent: Int = 0,
    val note: String,
    val createdAt: String = "Just now"
)

data class ProviderSlot(
    val id: String,
    val name: String,
    val category: String, // Visual, Narration, Script, Assembly, Publisher
    val tier: String, // Slot 1, Slot 2, Slot 3, Local Emergency
    val status: String = "healthy", // healthy, cooldown, degraded
    val latencyMs: Int = 240,
    val dailyQuotaUsedPercent: Int = 35,
    val cooldownSeconds: Int = 0
)

data class PlatformConnection(
    val id: String = UUID.randomUUID().toString(),
    val agentId: String,
    val platform: String, // YouTube, Instagram, Snapchat, Bilibili
    val status: String = "unconfigured", // unconfigured, sandbox_verified, live_authenticated
    val locator: String = "vault://stph-secrets/unconfigured",
    val lastVerified: String = "Not configured"
)

data class ApprovalItem(
    val id: String = UUID.randomUUID().toString(),
    val artifactHash: String,
    val channelName: String,
    val title: String,
    val destination: String,
    val caption: String,
    val disclosure: String,
    val affiliateLinks: String,
    val status: String = "pending", // pending, approved, rejected
    val createdAt: String = "11:35 AM"
)

data class EvidenceEvent(
    val id: String = UUID.randomUUID().toString(),
    val eventType: String,
    val agentId: String,
    val channelSlug: String,
    val stage: String,
    val artifactHash: String,
    val verificationReceipt: String,
    val timestamp: String = "2026-10-17 08:32 UTC"
)

data class HermesDecision(
    val id: String = UUID.randomUUID().toString(),
    val topic: String,
    val decision: String,
    val rationale: String,
    val authorityTier: String = "Tier 1: Autonomous",
    val timestamp: String = "11:30 AM"
)

data class InspectionModalData(
    val title: String,
    val slotKey: String,
    val durationSeconds: Int,
    val resolution: String,
    val aspectRatio: String,
    val lufs: String,
    val codec: String,
    val sha256: String,
    val isVerified: Boolean
)
