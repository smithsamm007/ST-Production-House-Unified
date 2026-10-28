package com.example.stproductionhouse

import com.example.stproductionhouse.data.model.DirectorSchedule
import com.example.stproductionhouse.data.repository.ProductionHouseRepository
import com.example.stproductionhouse.ui.viewmodel.ProductionViewModel
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ProductionHouseTest {

    private lateinit var repository: ProductionHouseRepository
    private lateinit var viewModel: ProductionViewModel

    @Before
    fun setup() {
        repository = ProductionHouseRepository()
        viewModel = ProductionViewModel(repository)
    }

    @Test
    fun testAuthenticationAndSession() {
        val initialOwner = repository.currentOwner.value
        assertNotNull(initialOwner)
        assertEquals("owner@stproduction.demo", initialOwner?.email)

        repository.logout()
        assertNull(repository.currentOwner.value)

        val success = repository.login("owner@stproduction.demo", "any-demo-password")
        assertTrue(success)
        assertNotNull(repository.currentOwner.value)
        // Issue #247 honesty: no demo password may be stored or shipped in app state.
        assertEquals("", viewModel.loginPassword.value)
        // Demo evidence must be labeled demo://, never presented as a provider receipt.
        assertTrue(repository.evidenceEvents.value.first().verificationReceipt.startsWith("demo://"))
    }

    @Test
    fun testCanonicalChannelsAndDirectors() {
        val channels = repository.channels.value
        assertEquals(4, channels.size)

        // Verify Rule 15: Public branding used, agentId linked
        val horrorChannel = channels.find { it.slug == "midnight-horror-hindi" }
        assertNotNull(horrorChannel)
        assertEquals("Midnight Horror Studios", horrorChannel?.displayName)
        assertEquals("agent-01", horrorChannel?.agentId)

        // Verify 4 canonical media slots per channel (Rule 8)
        assertEquals(4, horrorChannel?.slots?.size)
        val slotKeys = horrorChannel?.slots?.map { it.key }
        assertTrue(slotKeys?.contains("main_video") == true)
        assertTrue(slotKeys?.contains("content_reel_1") == true)
        assertTrue(slotKeys?.contains("content_reel_2") == true)
        assertTrue(slotKeys?.contains("brand_reel") == true)

        // Verify 21 canonical directors registered
        assertEquals(21, repository.agents.size)
        assertTrue(repository.agents.size <= 50)
    }

    @Test
    fun testAddChannelAndEvidenceAudit() {
        val initialEvidenceCount = repository.evidenceEvents.value.size
        repository.addChannel(
            slug = "cyber-mecha-tokyo",
            displayName = "Cyber Mecha Studio",
            tagline = "High octane robotic battles in futuristic Neo-Tokyo",
            language = "Japanese / English",
            agentId = "agent-05",
            launchTitle = "Iron Vanguard Episode 1"
        )

        val updatedChannels = repository.channels.value
        assertEquals(5, updatedChannels.size)
        val newChan = updatedChannels.find { it.slug == "cyber-mecha-tokyo" }
        assertNotNull(newChan)

        // Verify evidence event was immutably recorded
        val newEvidenceCount = repository.evidenceEvents.value.size
        assertTrue(newEvidenceCount > initialEvidenceCount)
        val latestEvent = repository.evidenceEvents.value.first()
        assertEquals("CHANNEL_REGISTERED", latestEvent.eventType)
        assertTrue(latestEvent.artifactHash.startsWith("sha256:"))
        assertTrue(latestEvent.verificationReceipt.startsWith("demo://"))
    }

    @Test
    fun testProductionPipelineAdvanceAndQCApprovalGate() {
        val initialReleases = repository.releases.value
        val release = initialReleases.first()
        assertEquals("visual", release.currentStage) // rel-01 starts at visual

        // Advance until QC stage
        val relId = "rel-03" // starts at assembly
        repository.advancePipelineStage(relId)
        val afterAssembly = repository.releases.value.find { it.id == relId }
        assertEquals("reels", afterAssembly?.currentStage)

        repository.advancePipelineStage(relId)
        val afterReels = repository.releases.value.find { it.id == relId }
        assertEquals("packaging", afterReels?.currentStage)

        repository.advancePipelineStage(relId)
        val afterPackaging = repository.releases.value.find { it.id == relId }
        assertEquals("qc", afterPackaging?.currentStage)

        // Honesty (issue #247): on-device stage advancement fabricates nothing — no Rule-7 approval
        // may be auto-created from a demo stage change, and stage logs must not claim real renders.
        val approvalsAfterAdvance = repository.approvals.value
        assertFalse(approvalsAfterAdvance.any { it.title.contains("QC Gate Cleared") })
        val advancedRelease = repository.releases.value.find { it.id == relId }
        assertTrue(advancedRelease?.executionLog?.any { it.endsWith("no render, QC gate or provider execution occurred.") } == true)
    }

    @Test
    fun testDirectorCommunicationAndAutoReply() {
        val initialMessagesCount = repository.messages.value.filter { it.agentId == "agent-01" }.size

        // Owner sends instruction
        repository.sendMessage("agent-01", "instruction", "owner", "Please sharpen rim lighting in Scene 3.")

        val updatedMessages = repository.messages.value.filter { it.agentId == "agent-01" }
        // Should contain owner message AND director automatic contextual reply
        assertTrue(updatedMessages.size >= initialMessagesCount + 2)
        val directorReply = updatedMessages.last()
        assertEquals("director", directorReply.sender)
        // Honesty (issue #247): simulated director replies must be labeled as demo.
        assertTrue(directorReply.body.startsWith("[demo simulated reply]"))
        assertTrue(directorReply.body.contains("Confirmed"))
    }

    @Test
    fun testScheduleSaveAndRunSlot() {
        val schedule = DirectorSchedule(
            agentId = "agent-01",
            mainEpisodeDuration = 2400,
            episodesPerDay = 3,
            productionDays = setOf(1, 2, 3, 4, 5),
            preferredStartTime = "11:00",
            timezone = "Asia/Kolkata",
            enabled = true
        )
        repository.saveSchedule(schedule)
        assertEquals(2400, repository.schedules.value["agent-01"]?.mainEpisodeDuration)

        val resultMsg = repository.runSchedulerNow("agent-01")
        // Honesty (issue #247): scheduler feedback must say the tick is a demo simulation.
        assertTrue(resultMsg.startsWith("[demo]"))
        assertTrue(resultMsg.contains("Slot queued successfully"))
        val latestRelease = repository.releases.value.first()
        assertTrue(latestRelease.title.contains("Midnight Horror Studios"))
    }

    @Test
    fun testSha256Integrity() {
        val hash = repository.computeSha256("test-integrity-payload")
        assertTrue(hash.startsWith("sha256:"))
        assertEquals(71, hash.length) // "sha256:" (7) + 64 hex chars = 71
    }

    @Test
    fun testDemoEvidenceAndInspectionAreHonestlyLabeled() {
        // Issue #247 honesty: seeded fixtures and the inspection modal may not claim
        // rendered/verified provider facts — every evidence receipt is demo://, and the
        // inspection modal never reports verified=true for demo media slots.
        val seededReceipts = repository.evidenceEvents.value.map { it.verificationReceipt }
        assertTrue(seededReceipts.isNotEmpty())
        assertTrue(seededReceipts.all { it.startsWith("demo://") })

        val seededEventTypes = repository.evidenceEvents.value.map { it.eventType }
        assertFalse(seededEventTypes.contains("ASSEMBLY_RENDERED"))
        assertFalse(seededEventTypes.contains("NARRATION_SYNTHESIZED"))

        val slot = repository.channels.value.first().slots.first()
        assertFalse(slot.verified)
        val modal = repository.inspectArtifact(slot, "midnight-horror-hindi")
        assertFalse(modal.isVerified)
        assertTrue(modal.sha256.startsWith("sha256:"))

        // Demo media slots declare plan-only state: no sha256, no measured LUFS/codec.
        assertNull(slot.artifactHash)
        assertEquals("demo plan", slot.lufsAudio)
        assertEquals("demo plan", slot.codec)

        // Provider and connection fixtures stay honestly unconfigured.
        assertTrue(repository.providers.value.none { it.tier == "OAuth Verified" })
        assertTrue(repository.platformConnections.value.all { it.status == "unconfigured" && it.lastVerified == "Not configured" })
    }
}
