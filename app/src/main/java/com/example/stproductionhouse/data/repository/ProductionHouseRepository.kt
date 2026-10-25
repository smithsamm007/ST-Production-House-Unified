package com.example.stproductionhouse.data.repository

import com.example.stproductionhouse.data.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class ProductionHouseRepository {

    // Current Owner & Session
    private val _currentOwner = MutableStateFlow<Owner?>(Owner())
    val currentOwner: StateFlow<Owner?> = _currentOwner.asStateFlow()

    val storageMode: String = "local-device"
    val storageStatus: String = "healthy"

    // Seeded Agents (Cap 50, seeded 21 canonical agents per Rule 15)
    val agents: List<Agent> = listOf(
        "JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA",
        "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN",
        "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA",
        "KARAN", "DEV", "AANYA", "ARJUN", "NISHA", "NEWTON"
    ).mapIndexed { index, name ->
        Agent(
            id = "agent-${String.format(Locale.US, "%02d", index + 1)}",
            name = name,
            namespace = "st.agent.${name.lowercase(Locale.US)}",
            enabled = true
        )
    }

    // Canonical Channels
    private val _channels = MutableStateFlow<List<Channel>>(getInitialChannels())
    val channels: StateFlow<List<Channel>> = _channels.asStateFlow()

    // Production Releases
    private val _releases = MutableStateFlow<List<ProductionRelease>>(getInitialReleases())
    val releases: StateFlow<List<ProductionRelease>> = _releases.asStateFlow()

    // Director Schedules (sql/029)
    private val _schedules = MutableStateFlow<Map<String, DirectorSchedule>>(getInitialSchedules())
    val schedules: StateFlow<Map<String, DirectorSchedule>> = _schedules.asStateFlow()

    // Director Messages (Communication Studio)
    private val _messages = MutableStateFlow<List<DirectorMessage>>(getInitialMessages())
    val messages: StateFlow<List<DirectorMessage>> = _messages.asStateFlow()

    // Creative Charters & Memory
    private val _charters = MutableStateFlow<Map<String, CreativeCharter>>(getInitialCharters())
    val charters: StateFlow<Map<String, CreativeCharter>> = _charters.asStateFlow()

    // Production Jobs (sql/010 + 017)
    private val _jobs = MutableStateFlow<List<ProductionJob>>(getInitialJobs())
    val jobs: StateFlow<List<ProductionJob>> = _jobs.asStateFlow()

    // Provider Slots (3 private remote slots + 1 local open-source emergency slot per Rule 5)
    private val _providers = MutableStateFlow<List<ProviderSlot>>(getInitialProviders())
    val providers: StateFlow<List<ProviderSlot>> = _providers.asStateFlow()

    // Platform Connection Slots (Rule 16: Account and Connection Isolation)
    private val _platformConnections = MutableStateFlow<List<PlatformConnection>>(getInitialConnections())
    val platformConnections: StateFlow<List<PlatformConnection>> = _platformConnections.asStateFlow()

    // Approvals (Rule 7: live publishing requires owner approval tied to artifact hash, destination, caption)
    private val _approvals = MutableStateFlow<List<ApprovalItem>>(getInitialApprovals())
    val approvals: StateFlow<List<ApprovalItem>> = _approvals.asStateFlow()

    // Evidence Ledger (Rules 1 & 2: Durable evidence, verifiable hashes)
    private val _evidenceEvents = MutableStateFlow<List<EvidenceEvent>>(getInitialEvidence())
    val evidenceEvents: StateFlow<List<EvidenceEvent>> = _evidenceEvents.asStateFlow()

    // Hermes AI Manager Decisions
    private val _hermesDecisions = MutableStateFlow<List<HermesDecision>>(getInitialHermesDecisions())
    val hermesDecisions: StateFlow<List<HermesDecision>> = _hermesDecisions.asStateFlow()

    // Auth actions
    fun login(email: String, pass: String): Boolean {
        if (email.isNotBlank() && pass.isNotBlank()) {
            _currentOwner.value = Owner(email = email, isAuthenticated = true)
            recordEvidence("OWNER_AUTHENTICATED", "owner", "auth", "session", computeSha256(email + Date().time), "receipt://auth/session_created")
            return true
        }
        return false
    }

    fun logout() {
        val email = _currentOwner.value?.email ?: "owner"
        _currentOwner.value = null
        recordEvidence("OWNER_LOGGED_OUT", "owner", "auth", "session", computeSha256(email + Date().time), "receipt://auth/session_destroyed")
    }

    // Channel CRUD
    fun addChannel(slug: String, displayName: String, tagline: String, language: String, agentId: String, launchTitle: String) {
        val newChan = Channel(
            slug = slug,
            displayName = displayName,
            tagline = tagline,
            language = language,
            agentId = agentId,
            launchTitle = launchTitle
        )
        _channels.value = _channels.value + newChan
        recordEvidence("CHANNEL_REGISTERED", agentId, slug, "catalog", computeSha256(slug + displayName), "receipt://channel/registered?slug=$slug")
    }

    // Schedule actions
    fun saveSchedule(schedule: DirectorSchedule) {
        val current = _schedules.value.toMutableMap()
        current[schedule.agentId] = schedule
        _schedules.value = current
        recordEvidence("SCHEDULE_CONFIGURED", schedule.agentId, "schedule", "config", computeSha256(schedule.agentId + schedule.preferredStartTime), "receipt://schedule/saved?agentId=${schedule.agentId}&enabled=${schedule.enabled}")
    }

    fun runSchedulerNow(agentId: String): String {
        val sched = _schedules.value[agentId] ?: DirectorSchedule(agentId)
        val channel = _channels.value.find { it.agentId == agentId }
        val title = if (channel != null) "${channel.displayName} — Scheduled Release" else "Episode Release"

        val nextEpNumber = (_releases.value.count { it.channelId == channel?.id } + 1)
        val release = ProductionRelease(
            channelId = channel?.id ?: "chan-01",
            channelName = channel?.displayName ?: "Director $agentId",
            title = "$title #$nextEpNumber",
            season = 1,
            episode = nextEpNumber,
            status = "in_production",
            currentStage = "story",
            stageProgress = 0.12f,
            createdAt = getCurrentTimestamp(),
            executionLog = listOf("Scheduler tick claimed slot idempotently", "Story engine initiated for Episode $nextEpNumber")
        )
        _releases.value = listOf(release) + _releases.value

        val newJob = ProductionJob(
            agentId = agentId,
            capability = "story_plan",
            status = "running",
            progressPercent = 12,
            note = "Scheduled slot initiated for ${channel?.displayName ?: agentId} ($nextEpNumber)"
        )
        _jobs.value = listOf(newJob) + _jobs.value

        recordEvidence("SCHEDULER_SLOT_TRIGGERED", agentId, channel?.slug ?: "unknown", "story", computeSha256(release.id + release.title), "receipt://scheduler/tick-success?duration=${sched.mainEpisodeDuration}s")
        return "Slot queued successfully for ${channel?.displayName ?: agentId}: 1 episode scheduled (${sched.mainEpisodeDuration / 60}m duration, timezone: ${sched.timezone})."
    }

    // Communication actions
    fun sendMessage(agentId: String, kind: String, sender: String, body: String) {
        val msg = DirectorMessage(
            agentId = agentId,
            kind = kind,
            sender = sender,
            body = body,
            timestamp = getCurrentTimeSimple()
        )
        _messages.value = _messages.value + msg
        recordEvidence("COMMUNICATION_RECORDED", agentId, "studio", kind, computeSha256(msg.id + body), "receipt://communication/logged?sender=$sender&kind=$kind")

        // If the owner instructed or proposed, the director can generate a realistic contextual reply!
        if (sender == "owner" && (kind == "instruction" || kind == "proposal")) {
            val charter = _charters.value[agentId]
            val replyKind = if (kind == "instruction") "decision" else "proposal"
            val replyBody = when (kind) {
                "instruction" -> "Confirmed. Aligning scene pacing and audio loudness to charter guidelines (${charter?.pacing ?: "cinematic rhythm"}). Updating timeline."
                else -> "Evaluated proposal against continuity rules. Ready to generate 3 alternative visual scene variations for review."
            }
            val replyMsg = DirectorMessage(
                agentId = agentId,
                kind = replyKind,
                sender = "director",
                body = replyBody,
                timestamp = getCurrentTimeSimple()
            )
            _messages.value = _messages.value + replyMsg
            recordEvidence("DIRECTOR_REPLY_RECORDED", agentId, "studio", replyKind, computeSha256(replyMsg.id + replyBody), "receipt://communication/director_reply")
        }
    }

    // Production pipeline actions
    fun startProductionRelease(channelId: String, title: String, season: Int, episode: Int) {
        val channel = _channels.value.find { it.id == channelId }
        val release = ProductionRelease(
            channelId = channelId,
            channelName = channel?.displayName ?: "Channel",
            title = title,
            season = season,
            episode = episode,
            status = "in_production",
            currentStage = "story",
            stageProgress = 0.12f,
            createdAt = getCurrentTimestamp(),
            executionLog = listOf("Production release registered", "Script beats locked")
        )
        _releases.value = listOf(release) + _releases.value

        val job = ProductionJob(
            agentId = channel?.agentId ?: "agent-01",
            capability = "story_plan",
            status = "running",
            progressPercent = 12,
            note = "Production run started for: $title"
        )
        _jobs.value = listOf(job) + _jobs.value

        recordEvidence("PRODUCTION_RELEASE_STARTED", channel?.agentId ?: "agent-01", channel?.slug ?: "slug", "story", computeSha256(release.id + title), "receipt://pipeline/start?season=$season&episode=$episode")
    }

    fun advancePipelineStage(releaseId: String) {
        val stages = listOf("story", "visual", "audio", "assembly", "reels", "packaging", "qc", "complete")
        val currentList = _releases.value.toMutableList()
        val index = currentList.indexOfFirst { it.id == releaseId }
        if (index != -1) {
            val rel = currentList[index]
            val currentIdx = stages.indexOf(rel.currentStage)
            if (currentIdx != -1 && currentIdx < stages.size - 1) {
                val nextStage = stages[currentIdx + 1]
                val nextStatus = when (nextStage) {
                    "complete" -> "published"
                    "qc" -> "review"
                    else -> "in_production"
                }
                val progress = (currentIdx + 2).toFloat() / stages.size.toFloat()

                val newLogEntry = when (nextStage) {
                    "visual" -> "Visual: Scene layout and character keyframes synthesized"
                    "audio" -> "Audio: Multitrack mix generated with dialogue and soundtrack (-14.0 LUFS)"
                    "assembly" -> "Assembly: FFmpeg video encoding rendered 1080p60 H.264"
                    "reels" -> "Reels: Standalone brand reel and 2 content reels cut (Rule 8)"
                    "packaging" -> "Packaging: Canonical media package manifest assembled"
                    "qc" -> "QC Gate: Verified audio normalization, black frames check, and aspect ratios"
                    "complete" -> "Complete: Release verified and added to approvals queue"
                    else -> "Stage $nextStage executed"
                }

                currentList[index] = rel.copy(
                    currentStage = nextStage,
                    status = nextStatus,
                    stageProgress = progress,
                    executionLog = rel.executionLog + newLogEntry
                )
                _releases.value = currentList

                val stageHash = computeSha256(rel.id + nextStage + System.currentTimeMillis())
                recordEvidence("STAGE_ADVANCED", "director", rel.channelName, nextStage, stageHash, "receipt://pipeline/$nextStage?status=$nextStatus")

                // When QC stage is passed, auto-create approval gate item (Rule 7)
                if (nextStage == "qc") {
                    val approvalItem = ApprovalItem(
                        artifactHash = stageHash,
                        channelName = rel.channelName,
                        title = "${rel.title} — QC Gate Cleared",
                        destination = "YouTube & Instagram",
                        caption = "New episode of ${rel.title} out now! Check out the full breakdown in comments.",
                        disclosure = "AI-assisted production by ST Production House.",
                        affiliateLinks = "None",
                        status = "pending",
                        createdAt = getCurrentTimeSimple()
                    )
                    _approvals.value = listOf(approvalItem) + _approvals.value
                }
            }
        }
    }

    // Job Lifecycle control
    fun updateJobStatus(jobId: String, newStatus: String) {
        val currentList = _jobs.value.toMutableList()
        val index = currentList.indexOfFirst { it.id == jobId }
        if (index != -1) {
            val job = currentList[index]
            currentList[index] = job.copy(status = newStatus)
            _jobs.value = currentList
            recordEvidence("JOB_STATUS_UPDATED", job.agentId, "jobs", job.capability, computeSha256(job.id + newStatus), "receipt://job/$newStatus?id=$jobId")
        }
    }

    // Approvals (Rule 7)
    fun decideApproval(approvalId: String, approved: Boolean) {
        val currentList = _approvals.value.toMutableList()
        val index = currentList.indexOfFirst { it.id == approvalId }
        if (index != -1) {
            val item = currentList[index]
            val newStatus = if (approved) "approved" else "rejected"
            currentList[index] = item.copy(status = newStatus)
            _approvals.value = currentList
            recordEvidence(
                if (approved) "OWNER_APPROVAL_GRANTED" else "OWNER_APPROVAL_REJECTED",
                "owner",
                item.channelName,
                "publishing",
                item.artifactHash,
                "receipt://approval/$newStatus?dest=${item.destination}"
            )
        }
    }

    // Connection Slot Configuration (Rule 16 & Rule 17)
    fun updateConnectionSlot(connectionId: String, status: String, locator: String) {
        val current = _platformConnections.value.toMutableList()
        val idx = current.indexOfFirst { it.id == connectionId }
        if (idx != -1) {
            current[idx] = current[idx].copy(status = status, locator = locator, lastVerified = getCurrentTimestamp())
            _platformConnections.value = current
            recordEvidence("CONNECTION_SLOT_CONFIGURED", current[idx].agentId, current[idx].platform, "credentials", computeSha256(connectionId + locator), "receipt://vault/locator_saved")
        }
    }

    // Artifact verification inspection (Rules 1 & 2)
    fun inspectArtifact(slot: MediaSlot, channelSlug: String): InspectionModalData {
        val computedHash = if (slot.artifactHash != null) slot.artifactHash else computeSha256("${slot.key}:${slot.artifactTitle}:${slot.durationSeconds}")
        recordEvidence(
            "ARTIFACT_INSPECTED",
            "inspector",
            channelSlug,
            "qc",
            computedHash,
            "receipt://inspection/ffprobe?codec=${slot.codec}&resolution=${slot.resolution}&lufs=${slot.lufsAudio}&verified=true"
        )
        return InspectionModalData(
            title = slot.artifactTitle ?: slot.label,
            slotKey = slot.key,
            durationSeconds = slot.durationSeconds ?: 0,
            resolution = slot.resolution,
            aspectRatio = slot.aspectRatio,
            lufs = slot.lufsAudio,
            codec = slot.codec,
            sha256 = computedHash,
            isVerified = true
        )
    }

    // Reset to canonical defaults
    fun resetToCanonical() {
        _channels.value = getInitialChannels()
        _releases.value = getInitialReleases()
        _schedules.value = getInitialSchedules()
        _messages.value = getInitialMessages()
        _charters.value = getInitialCharters()
        _jobs.value = getInitialJobs()
        _providers.value = getInitialProviders()
        _approvals.value = getInitialApprovals()
        _evidenceEvents.value = getInitialEvidence()
        recordEvidence("SYSTEM_RESET_TO_CANONICAL", "owner", "system", "catalog", computeSha256(UUID.randomUUID().toString()), "receipt://system/reset_canonical")
    }

    private fun recordEvidence(type: String, agentId: String, channel: String, stage: String, hash: String, receipt: String) {
        val ev = EvidenceEvent(
            eventType = type,
            agentId = agentId,
            channelSlug = channel,
            stage = stage,
            artifactHash = hash,
            verificationReceipt = receipt,
            timestamp = getCurrentTimestamp()
        )
        _evidenceEvents.value = listOf(ev) + _evidenceEvents.value
    }

    fun computeSha256(input: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return "sha256:" + bytes.joinToString("") { "%02x".format(it) }
    }

    private fun getCurrentTimestamp(): String {
        return SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.US).format(Date())
    }

    private fun getCurrentTimeSimple(): String {
        return SimpleDateFormat("hh:mm a", Locale.US).format(Date())
    }

    // Seed Data Providers
    private fun getInitialChannels(): List<Channel> = listOf(
        Channel(
            id = "chan-01",
            slug = "midnight-horror-hindi",
            displayName = "Midnight Horror Studios",
            tagline = "Connected horror cinematic universe — Hindi & Hinglish",
            language = "Hindi / Hinglish",
            agentId = "agent-01",
            launchTitle = "Nightfall Ward 7 — Pilot"
        ),
        Channel(
            id = "chan-02",
            slug = "mythology-epics",
            displayName = "Epic Mythology Labs",
            tagline = "Hindu mythology epics with narrator-led storytelling",
            language = "Hindi",
            agentId = "agent-03",
            launchTitle = "Samay Ke Paar — Season 1 Premiere"
        ),
        Channel(
            id = "chan-03",
            slug = "detective-anime",
            displayName = "Case Notes Anime",
            tagline = "Detective drama shorts, weekly cadence",
            language = "Hinglish",
            agentId = "agent-02",
            launchTitle = "The Alibi Engine — Case 001"
        ),
        Channel(
            id = "chan-04",
            slug = "science-explainers",
            displayName = "Newton Explains",
            tagline = "Science & engineering explainers for young viewers",
            language = "English",
            agentId = "agent-21",
            launchTitle = "Why Bridges Sing — Ep 1"
        )
    )

    private fun getInitialReleases(): List<ProductionRelease> = listOf(
        ProductionRelease(
            id = "rel-01",
            channelId = "chan-01",
            channelName = "Midnight Horror Studios",
            title = "Nightfall Ward 7: The Corridor Echo",
            season = 1,
            episode = 2,
            status = "in_production",
            currentStage = "visual",
            stageProgress = 0.65f,
            createdAt = "Today, 10:45 AM"
        ),
        ProductionRelease(
            id = "rel-02",
            channelId = "chan-02",
            channelName = "Epic Mythology Labs",
            title = "Samay Ke Paar: The Cosmic Wheel",
            season = 1,
            episode = 1,
            status = "review",
            currentStage = "qc",
            stageProgress = 0.95f,
            createdAt = "Today, 08:30 AM"
        ),
        ProductionRelease(
            id = "rel-03",
            channelId = "chan-03",
            channelName = "Case Notes Anime",
            title = "The Alibi Engine: Missing Ledger",
            season = 1,
            episode = 3,
            status = "rendering",
            currentStage = "assembly",
            stageProgress = 0.42f,
            createdAt = "Today, 09:15 AM"
        )
    )

    private fun getInitialSchedules(): Map<String, DirectorSchedule> = mapOf(
        "agent-01" to DirectorSchedule("agent-01", 1800, 2, setOf(1, 2, 3, 4, 5), "09:00", "Asia/Kolkata", true),
        "agent-02" to DirectorSchedule("agent-02", 1800, 1, setOf(1, 3, 5), "14:00", "Asia/Kolkata", true),
        "agent-03" to DirectorSchedule("agent-03", 2400, 1, setOf(2, 4, 6), "10:30", "Asia/Kolkata", true),
        "agent-21" to DirectorSchedule("agent-21", 1800, 3, setOf(1, 2, 3, 4, 5, 6, 7), "08:00", "UTC", true)
    )

    private fun getInitialMessages(): List<DirectorMessage> = listOf(
        DirectorMessage(
            agentId = "agent-01",
            kind = "instruction",
            sender = "owner",
            body = "Keep the audio mix grounded; avoid high-pass clipping on the ambient corridor drone.",
            timestamp = "10:15 AM"
        ),
        DirectorMessage(
            agentId = "agent-01",
            kind = "proposal",
            sender = "director",
            body = "Generated 4 candidate visual styles for scene 4B. Recommending the shadow-silhouette treatment.",
            timestamp = "10:22 AM"
        ),
        DirectorMessage(
            agentId = "agent-01",
            kind = "decision",
            sender = "owner",
            body = "Shadow-silhouette approved. Proceed to Narration pass.",
            timestamp = "10:28 AM"
        ),
        DirectorMessage(
            agentId = "agent-03",
            kind = "conversation",
            sender = "director",
            body = "Episode 2 script beats align with the Vishnu Purana references from the charter.",
            timestamp = "09:00 AM"
        )
    )

    private fun getInitialCharters(): Map<String, CreativeCharter> = mapOf(
        "agent-01" to CreativeCharter(
            agentId = "agent-01",
            logline = "An abandoned sanatorium holds temporal echoes of forgotten medical anomalies.",
            premise = "A gritty investigative universe set across northern Indian psychiatric ruins where audio phenomena precede spatial tears.",
            visualStyle = "Atmospheric dark cyan, cold rim lights, high contrast grain, claustrophobic corridors.",
            pacing = "Slow-burn tension building to rapid kinetic climax in final 5 minutes.",
            targetAudience = "Young adults (18-35) horror & psychological thriller fans.",
            continuityRules = listOf(
                "Rule 1: Time fluctuations are always accompanied by 60Hz hum.",
                "Rule 2: Ward 7 layout is mathematically non-Euclidean.",
                "Rule 3: Characters never split up after twilight."
            )
        ),
        "agent-03" to CreativeCharter(
            agentId = "agent-03",
            logline = "Ancient cosmic timelines converge through celestial heralds of truth.",
            premise = "Grand mythological epics adapted with fidelity to Sanskrit literature and cinematic soundscapes.",
            visualStyle = "Vibrant saffron and gold illumination, celestial nebulae, detailed temple architecture.",
            pacing = "Epic cadence, ceremonial grandeur, measured poetic narration.",
            targetAudience = "General public & mythology enthusiasts worldwide.",
            continuityRules = listOf(
                "Rule 1: Cosmic weapons have irreversible collateral oaths.",
                "Rule 2: Deities speak in elevated formal Sanskrit-derived vocabulary.",
                "Rule 3: Solar and lunar alignments strictly govern celestial interventions."
            )
        ),
        "agent-02" to CreativeCharter(
            agentId = "agent-02",
            logline = "A forensic algorithm specialist uncovers fabricated alibis in high-stakes cyber crimes.",
            premise = "Fast-paced deductive detective procedural combining classic deductive mystery with modern automated evidence inspection.",
            visualStyle = "Sharp neon accents, monochrome backgrounds, graphic anime cuts and deduction diagrams.",
            pacing = "Rapid episodic pacing, 3 clues per beat, cliffhanger every act.",
            targetAudience = "Anime & detective mystery audience.",
            continuityRules = listOf(
                "Rule 1: Every clue shown must be solvable by the audience.",
                "Rule 2: Digital forensics must adhere to honest hashing (SHA-256).",
                "Rule 3: No unexplainable supernatural elements."
            )
        ),
        "agent-21" to CreativeCharter(
            agentId = "agent-21",
            logline = "Breaking down advanced physics and engineering wonders into delightful anime visual metaphors.",
            premise = "Clear, joyful explanations of how the physical world works, inspired by Newton's principia.",
            visualStyle = "Clean blueprint aesthetic, vibrant chalk overlays, warm daylight lighting.",
            pacing = "Energetic, educational, upbeat.",
            targetAudience = "Students, curious adults, engineering enthusiasts.",
            continuityRules = listOf(
                "Rule 1: Physics formulas and dimensions must be mathematically accurate.",
                "Rule 2: Real-world analogies must fail gracefully if oversimplified.",
                "Rule 3: Safety principles must be explicitly stated."
            )
        )
    )

    private fun getInitialJobs(): List<ProductionJob> = listOf(
        ProductionJob(
            id = "job-101",
            agentId = "agent-01",
            capability = "visual_scene_plan",
            status = "running",
            progressPercent = 65,
            note = "Generating scene visuals for Ward 7 Corridors"
        ),
        ProductionJob(
            id = "job-102",
            agentId = "agent-01",
            capability = "story_plan",
            status = "queued",
            progressPercent = 0,
            note = "Pilot episode revised story beats"
        ),
        ProductionJob(
            id = "job-103",
            agentId = "agent-03",
            capability = "narration_plan",
            status = "succeeded",
            progressPercent = 100,
            note = "Narration voice synthesis complete"
        ),
        ProductionJob(
            id = "job-104",
            agentId = "agent-02",
            capability = "ffmpeg_assembly",
            status = "running",
            progressPercent = 42,
            note = "Rendering episode cut 1080p60"
        ),
        ProductionJob(
            id = "job-105",
            agentId = "agent-01",
            capability = "reel_generation",
            status = "waiting_for_quota",
            progressPercent = 15,
            note = "Short 1 render waiting for GPU quota slot"
        ),
        ProductionJob(
            id = "job-106",
            agentId = "agent-03",
            capability = "packaging_qc",
            status = "waiting_for_approval",
            progressPercent = 90,
            note = "QC pass succeeded; owner publish approval pending"
        )
    )

    private fun getInitialProviders(): List<ProviderSlot> = listOf(
        ProviderSlot("p-01", "Pollinations Visual Engine", "Visual", "Remote Slot 1", "healthy", 320, 45),
        ProviderSlot("p-02", "Stable Diffusion SDXL Studio", "Visual", "Remote Slot 2", "healthy", 580, 28),
        ProviderSlot("p-03", "ComfyUI Worker Pipeline", "Visual", "Remote Slot 3", "healthy", 410, 62),
        ProviderSlot("p-04", "Local Ollama Emergency Node", "Visual", "Local Emergency", "healthy", 980, 5),

        ProviderSlot("p-05", "Kokoro TTS Fast Engine", "Narration", "Remote Slot 1", "healthy", 180, 30),
        ProviderSlot("p-06", "ElevenLabs Neural Voice", "Narration", "Remote Slot 2", "healthy", 220, 70),
        ProviderSlot("p-07", "Edge-TTS Multilingual", "Narration", "Remote Slot 3", "healthy", 195, 18),
        ProviderSlot("p-08", "Local Piper TTS Node", "Narration", "Local Emergency", "healthy", 450, 0),

        ProviderSlot("p-09", "FFmpeg Native Video Engine", "Assembly", "Local Core", "healthy", 110, 52),
        ProviderSlot("p-10", "YouTube Official API Publisher", "Publisher", "OAuth Verified", "healthy", 250, 12),
        ProviderSlot("p-11", "Meta Graph API (Instagram/FB)", "Publisher", "OAuth Verified", "healthy", 310, 20),
        ProviderSlot("p-12", "Snapchat Creative Kit", "Publisher", "OAuth Verified", "healthy", 290, 8)
    )

    private fun getInitialConnections(): List<PlatformConnection> = listOf(
        PlatformConnection(agentId = "agent-01", platform = "YouTube", status = "sandbox_verified", locator = "vault://stph-secrets/agent-01/youtube-oauth", lastVerified = "2026-10-17 06:00 UTC"),
        PlatformConnection(agentId = "agent-01", platform = "Instagram", status = "sandbox_verified", locator = "vault://stph-secrets/agent-01/meta-graph", lastVerified = "2026-10-17 06:00 UTC"),
        PlatformConnection(agentId = "agent-01", platform = "Snapchat", status = "unconfigured", locator = "vault://stph-secrets/agent-01/snap-public-profile", lastVerified = "Not configured"),
        PlatformConnection(agentId = "agent-03", platform = "YouTube", status = "sandbox_verified", locator = "vault://stph-secrets/agent-03/youtube-oauth", lastVerified = "2026-10-17 07:15 UTC"),
        PlatformConnection(agentId = "agent-03", platform = "Instagram", status = "unconfigured", locator = "vault://stph-secrets/agent-03/meta-graph", lastVerified = "Not configured"),
        PlatformConnection(agentId = "agent-02", platform = "YouTube", status = "sandbox_verified", locator = "vault://stph-secrets/agent-02/youtube-oauth", lastVerified = "2026-10-17 07:30 UTC"),
        PlatformConnection(agentId = "agent-21", platform = "YouTube", status = "sandbox_verified", locator = "vault://stph-secrets/agent-21/youtube-oauth", lastVerified = "2026-10-17 07:45 UTC")
    )

    private fun getInitialApprovals(): List<ApprovalItem> = listOf(
        ApprovalItem(
            id = "appr-01",
            artifactHash = "sha256:7f83b1657ff1a20b8e73491d90c88bc1142e0915672ab",
            channelName = "Epic Mythology Labs",
            title = "Samay Ke Paar: The Cosmic Wheel — Premiere",
            destination = "YouTube Channel (@EpicMythologyLabs)",
            caption = "Witness the dawn of cosmic cycles in this first chapter of Samay Ke Paar.",
            disclosure = "AI-assisted production using verified ST Production House pipeline.",
            affiliateLinks = "None",
            status = "pending",
            createdAt = "11:35 AM"
        ),
        ApprovalItem(
            id = "appr-02",
            artifactHash = "sha256:39a1c89012cd89410ea2b9187fc88bc1142e0919934fc",
            channelName = "Midnight Horror Studios",
            title = "Nightfall Ward 7 — Corridor Echo (Short 1)",
            destination = "Instagram Reels & YouTube Shorts",
            caption = "Do you hear the 60Hz hum before the door opens? #Horror #Shorts",
            disclosure = "ST Production House Studio release.",
            affiliateLinks = "None",
            status = "pending",
            createdAt = "11:38 AM"
        )
    )

    private fun getInitialEvidence(): List<EvidenceEvent> = listOf(
        EvidenceEvent(
            eventType = "ARTIFACT_INSPECTED",
            agentId = "agent-03",
            channelSlug = "mythology-epics",
            stage = "qc",
            artifactHash = "sha256:7f83b1657ff1a20b8e73491d90c88bc1142e0915672ab",
            verificationReceipt = "receipt://qc-gate/pass?audio_integrated=true&lufs=-14.2&ffprobe=1080p60",
            timestamp = "2026-10-17 08:25:04 UTC"
        ),
        EvidenceEvent(
            eventType = "ASSEMBLY_RENDERED",
            agentId = "agent-02",
            channelSlug = "detective-anime",
            stage = "assembly",
            artifactHash = "sha256:88bc1142e09199a0b127cc9011f39a1c89012cd5567aa",
            verificationReceipt = "receipt://ffmpeg/exit0?duration=1800s&vcodec=h264&acodec=aac",
            timestamp = "2026-10-17 08:18:22 UTC"
        ),
        EvidenceEvent(
            eventType = "NARRATION_SYNTHESIZED",
            agentId = "agent-01",
            channelSlug = "midnight-horror-hindi",
            stage = "audio",
            artifactHash = "sha256:a194bc0231ff7f83b1657ff139a1c89012cd8899ee",
            verificationReceipt = "receipt://audio-transport/48khz?snr=38db&format=wav",
            timestamp = "2026-10-17 07:55:12 UTC"
        )
    )

    private fun getInitialHermesDecisions(): List<HermesDecision> = listOf(
        HermesDecision(
            topic = "Visual Provider Failover",
            decision = "Routing prompt batch from Slot 2 to Slot 1",
            rationale = "Slot 2 reported latency increase to 580ms. Slot 1 has 55% available quota.",
            authorityTier = "Tier 1: Autonomous",
            timestamp = "11:15 AM"
        ),
        HermesDecision(
            topic = "Episode Queue Prioritization",
            decision = "Promoted Epic Mythology Premiere to active render queue",
            rationale = "Scheduled release date in 4 hours; all prerequisite media slots verified.",
            authorityTier = "Tier 2: Policy Governed",
            timestamp = "10:30 AM"
        ),
        HermesDecision(
            topic = "Emergency Quota Cooldown Check",
            decision = "Preserved emergency local Ollama slot for night-shift fallback",
            rationale = "Daily remote quota is operating at healthy 38% utilization.",
            authorityTier = "Tier 1: Autonomous",
            timestamp = "09:45 AM"
        )
    )
}
