package com.example.stproductionhouse.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.stproductionhouse.data.model.*
import com.example.stproductionhouse.data.repository.ProductionHouseRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

enum class ScreenSection(val title: String, val iconCode: String) {
    OVERVIEW("Command Center", "▦"),
    DIRECTORS("Directors", "◉"),
    SCHEDULE("Episode & Schedule", "⏱"),
    COMMUNICATION("Director Comm", "✉"),
    MEMORY("Director Memory", "▣"),
    PRODUCTION("Production", "▶"),
    JOBS("Active Jobs", "≡"),
    PROVIDERS("Providers & Quota", "⛁"),
    CONNECTIONS("OAuth & Secrets", "⚿"),
    APPROVALS("Approvals", "✓"),
    EVIDENCE("Evidence Ledger", "⛓"),
    HERMES("Hermes AI Manager", "✳"),
    SETTINGS("Settings", "⚙")
}

class ProductionViewModel(
    private val repository: ProductionHouseRepository = ProductionHouseRepository()
) : ViewModel() {

    val currentOwner = repository.currentOwner
    val channels = repository.channels
    val releases = repository.releases
    val schedules = repository.schedules
    val messages = repository.messages
    val charters = repository.charters
    val jobs = repository.jobs
    val providers = repository.providers
    val platformConnections = repository.platformConnections
    val approvals = repository.approvals
    val evidenceEvents = repository.evidenceEvents
    val hermesDecisions = repository.hermesDecisions
    val agents = repository.agents
    val storageMode = repository.storageMode
    val storageStatus = repository.storageStatus

    private val _currentSection = MutableStateFlow(ScreenSection.OVERVIEW)
    val currentSection: StateFlow<ScreenSection> = _currentSection.asStateFlow()

    private val _selectedAgentId = MutableStateFlow("agent-01")
    val selectedAgentId: StateFlow<String> = _selectedAgentId.asStateFlow()

    // Login state
    private val _loginEmail = MutableStateFlow("owner@stproduction.demo")
    val loginEmail: StateFlow<String> = _loginEmail.asStateFlow()

    private val _loginPassword = MutableStateFlow("demo-production-house-2026")
    val loginPassword: StateFlow<String> = _loginPassword.asStateFlow()

    private val _loginError = MutableStateFlow<String?>(null)
    val loginError: StateFlow<String?> = _loginError.asStateFlow()

    // Scheduler feedback banner
    private val _schedulerFeedback = MutableStateFlow<String?>(null)
    val schedulerFeedback: StateFlow<String?> = _schedulerFeedback.asStateFlow()

    // Search and filter states
    private val _channelSearchQuery = MutableStateFlow("")
    val channelSearchQuery: StateFlow<String> = _channelSearchQuery.asStateFlow()

    private val _jobStatusFilter = MutableStateFlow("ALL")
    val jobStatusFilter: StateFlow<String> = _jobStatusFilter.asStateFlow()

    private val _evidenceFilter = MutableStateFlow("ALL")
    val evidenceFilter: StateFlow<String> = _evidenceFilter.asStateFlow()

    // Artifact Inspection Modal
    private val _inspectionData = MutableStateFlow<InspectionModalData?>(null)
    val inspectionData: StateFlow<InspectionModalData?> = _inspectionData.asStateFlow()

    // Navigation
    fun navigateTo(section: ScreenSection) {
        _currentSection.value = section
    }

    fun selectAgent(agentId: String) {
        _selectedAgentId.value = agentId
    }

    // Login logic
    fun setLoginEmail(email: String) { _loginEmail.value = email }
    fun setLoginPassword(pass: String) { _loginPassword.value = pass }

    fun login() {
        _loginError.value = null
        val success = repository.login(_loginEmail.value, _loginPassword.value)
        if (!success) {
            _loginError.value = "Invalid credentials. Please enter email and password."
        }
    }

    fun logout() {
        repository.logout()
        _currentSection.value = ScreenSection.OVERVIEW
    }

    // Channels
    fun setChannelSearchQuery(query: String) {
        _channelSearchQuery.value = query
    }

    fun addChannel(slug: String, displayName: String, tagline: String, language: String, agentId: String, launchTitle: String) {
        repository.addChannel(slug, displayName, tagline, language, agentId, launchTitle)
    }

    // Schedule
    fun updateSchedule(schedule: DirectorSchedule) {
        repository.saveSchedule(schedule)
        _schedulerFeedback.value = "Schedule saved for Director ${schedule.agentId} (${schedule.episodesPerDay} eps/day, ${schedule.mainEpisodeDuration / 60}m)."
    }

    fun previewSchedulePlan(agentId: String) {
        val sched = schedules.value[agentId] ?: DirectorSchedule(agentId)
        _schedulerFeedback.value = "Plan Preview: ${sched.episodesPerDay} slots ready for production days ${sched.productionDays.sorted().joinToString { dayName(it) }} starting at ${sched.preferredStartTime} (${sched.timezone}). Quota check: HEALTHY."
    }

    fun runSchedulerNow(agentId: String) {
        val result = repository.runSchedulerNow(agentId)
        _schedulerFeedback.value = result
    }

    fun clearSchedulerFeedback() {
        _schedulerFeedback.value = null
    }

    // Communication
    fun sendDirectorMessage(agentId: String, kind: String, sender: String, body: String) {
        if (body.isNotBlank()) {
            repository.sendMessage(agentId, kind, sender, body)
        }
    }

    // Production
    fun startProduction(channelId: String, title: String, season: Int, episode: Int) {
        repository.startProductionRelease(channelId, title, season, episode)
    }

    fun advancePipeline(releaseId: String) {
        repository.advancePipelineStage(releaseId)
    }

    // Jobs
    fun setJobStatusFilter(filter: String) {
        _jobStatusFilter.value = filter
    }

    fun pauseJob(jobId: String) {
        repository.updateJobStatus(jobId, "paused")
    }

    fun resumeJob(jobId: String) {
        repository.updateJobStatus(jobId, "running")
    }

    fun cancelJob(jobId: String) {
        repository.updateJobStatus(jobId, "failed")
    }

    // Evidence
    fun setEvidenceFilter(filter: String) {
        _evidenceFilter.value = filter
    }

    // Approvals
    fun approveItem(id: String) {
        repository.decideApproval(id, true)
    }

    fun rejectItem(id: String) {
        repository.decideApproval(id, false)
    }

    // Connections
    fun updateConnectionSlot(connectionId: String, status: String, locator: String) {
        repository.updateConnectionSlot(connectionId, status, locator)
    }

    // Inspection
    fun inspectArtifact(slot: MediaSlot, channelSlug: String) {
        val data = repository.inspectArtifact(slot, channelSlug)
        _inspectionData.value = data
    }

    fun dismissInspection() {
        _inspectionData.value = null
    }

    // Reset
    fun resetToCanonical() {
        repository.resetToCanonical()
    }

    private fun dayName(day: Int): String = when (day) {
        1 -> "Mon"
        2 -> "Tue"
        3 -> "Wed"
        4 -> "Thu"
        5 -> "Fri"
        6 -> "Sat"
        7 -> "Sun"
        else -> ""
    }
}
