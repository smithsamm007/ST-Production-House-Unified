package com.example.stproductionhouse

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.ui.components.InspectionDialog
import com.example.stproductionhouse.ui.components.TopHeaderBar
import com.example.stproductionhouse.ui.screens.*
import com.example.stproductionhouse.ui.theme.*
import com.example.stproductionhouse.ui.viewmodel.ProductionViewModel
import com.example.stproductionhouse.ui.viewmodel.ScreenSection
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val viewModel: ProductionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            STProductionHouseTheme {
                val owner by viewModel.currentOwner.collectAsState()

                if (owner == null) {
                    val email by viewModel.loginEmail.collectAsState()
                    val password by viewModel.loginPassword.collectAsState()
                    val error by viewModel.loginError.collectAsState()

                    LoginScreen(
                        email = email,
                        onEmailChange = viewModel::setLoginEmail,
                        password = password,
                        onPasswordChange = viewModel::setLoginPassword,
                        errorMessage = error,
                        onLoginClick = viewModel::login,
                        modifier = Modifier
                            .fillMaxSize()
                            .safeDrawingPadding()
                    )
                } else {
                    AppShell(
                        viewModel = viewModel,
                        modifier = Modifier
                            .fillMaxSize()
                            .safeDrawingPadding()
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppShell(
    viewModel: ProductionViewModel,
    modifier: Modifier = Modifier
) {
    val currentSection by viewModel.currentSection.collectAsState()
    val owner by viewModel.currentOwner.collectAsState()
    val channels by viewModel.channels.collectAsState()
    val releases by viewModel.releases.collectAsState()
    val schedules by viewModel.schedules.collectAsState()
    val messages by viewModel.messages.collectAsState()
    val charters by viewModel.charters.collectAsState()
    val jobs by viewModel.jobs.collectAsState()
    val providers by viewModel.providers.collectAsState()
    val platformConnections by viewModel.platformConnections.collectAsState()
    val approvals by viewModel.approvals.collectAsState()
    val evidenceEvents by viewModel.evidenceEvents.collectAsState()
    val hermesDecisions by viewModel.hermesDecisions.collectAsState()
    val selectedAgentId by viewModel.selectedAgentId.collectAsState()
    val schedulerFeedback by viewModel.schedulerFeedback.collectAsState()

    val searchQuery by viewModel.channelSearchQuery.collectAsState()
    val jobStatusFilter by viewModel.jobStatusFilter.collectAsState()
    val evidenceFilter by viewModel.evidenceFilter.collectAsState()
    val inspectionData by viewModel.inspectionData.collectAsState()

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val coroutineScope = rememberCoroutineScope()

    // BackHandler: Return to Command Center if on a secondary view
    BackHandler(enabled = currentSection != ScreenSection.OVERVIEW) {
        viewModel.navigateTo(ScreenSection.OVERVIEW)
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = PanelDark,
                modifier = Modifier.width(300.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxHeight()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(
                        text = "OWNER CONSOLE",
                        color = AccentCyan,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 2.sp,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                    )

                    Divider(color = BorderDark, modifier = Modifier.padding(vertical = 4.dp))

                    ScreenSection.values().forEach { section ->
                        val isSelected = currentSection == section
                        NavigationDrawerItem(
                            label = {
                                Text(
                                    text = "${section.iconCode}  ${section.title}",
                                    color = if (isSelected) AccentCyan else TextPrimary,
                                    fontSize = 13.5.sp,
                                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                                )
                            },
                            selected = isSelected,
                            onClick = {
                                viewModel.navigateTo(section)
                                coroutineScope.launch { drawerState.close() }
                            },
                            colors = NavigationDrawerItemDefaults.colors(
                                selectedContainerColor = AccentBlue.copy(alpha = 0.2f),
                                unselectedContainerColor = Color.Transparent
                            ),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("nav_${section.name.lowercase()}")
                        )
                    }

                    Spacer(modifier = Modifier.weight(1f))

                    // Hermes Mini Stats
                    Card(
                        colors = CardDefaults.cardColors(containerColor = PanelDarkVariant),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(1.dp, BorderDark, RoundedCornerShape(8.dp))
                    ) {
                        Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text("Hermes AI Manager", color = AccentCyan, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            Text("Registered: ${viewModel.agents.size} directors", color = TextMuted, fontSize = 10.sp)
                            Text("Live Channels: ${channels.size}", color = TextMuted, fontSize = 10.sp)
                            Text("Central Platform: 1", color = TextMuted, fontSize = 10.sp)
                            Text("Storage: ${viewModel.storageMode} (${viewModel.storageStatus})", color = StatusOk, fontSize = 10.sp)
                        }
                    }
                }
            }
        }
    ) {
        Scaffold(
            topBar = {
                Column {
                    TopHeaderBar(
                        ownerEmail = owner?.email,
                        storageMode = viewModel.storageMode,
                        storageStatus = viewModel.storageStatus,
                        onLogout = viewModel::logout
                    )
                    // Sub-navigation bar with menu icon and current section indicator
                    Surface(
                        color = PanelDarkVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(1.dp, BorderDark)
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(
                                    onClick = { coroutineScope.launch { drawerState.open() } },
                                    modifier = Modifier.testTag("menu_drawer_button")
                                ) {
                                    Icon(Icons.Default.Menu, contentDescription = "Menu", tint = AccentCyan)
                                }
                                Text(
                                    text = "${currentSection.iconCode}  ${currentSection.title.uppercase()}",
                                    color = TextPrimary,
                                    fontSize = 12.5.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 1.sp
                                )
                            }

                            if (currentSection != ScreenSection.OVERVIEW) {
                                TextButton(
                                    onClick = { viewModel.navigateTo(ScreenSection.OVERVIEW) }
                                ) {
                                    Text("Command Center", color = AccentCyan, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            },
            bottomBar = {
                // Quick navigation bar for top 5 core workflows
                NavigationBar(
                    containerColor = PanelDark,
                    tonalElevation = 4.dp,
                    windowInsets = WindowInsets.navigationBars
                ) {
                    val coreTabs = listOf(
                        ScreenSection.OVERVIEW,
                        ScreenSection.DIRECTORS,
                        ScreenSection.SCHEDULE,
                        ScreenSection.PRODUCTION,
                        ScreenSection.JOBS
                    )

                    coreTabs.forEach { tab ->
                        val isSelected = currentSection == tab
                        NavigationBarItem(
                            selected = isSelected,
                            onClick = { viewModel.navigateTo(tab) },
                            icon = {
                                Text(
                                    text = tab.iconCode,
                                    fontSize = 16.sp,
                                    color = if (isSelected) AccentCyan else TextMuted
                                )
                            },
                            label = {
                                Text(
                                    text = when (tab) {
                                        ScreenSection.OVERVIEW -> "Command"
                                        ScreenSection.DIRECTORS -> "Directors"
                                        ScreenSection.SCHEDULE -> "Schedule"
                                        ScreenSection.PRODUCTION -> "Production"
                                        ScreenSection.JOBS -> "Jobs"
                                        else -> tab.title
                                    },
                                    fontSize = 10.sp,
                                    color = if (isSelected) AccentCyan else TextMuted,
                                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = AccentBlue.copy(alpha = 0.2f)
                            ),
                            modifier = Modifier.testTag("bottom_tab_${tab.name.lowercase()}")
                        )
                    }
                }
            },
            containerColor = BgDark,
            modifier = modifier
        ) { paddingValues ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                when (currentSection) {
                    ScreenSection.OVERVIEW -> OverviewScreen(
                        channels = channels,
                        releases = releases,
                        jobs = jobs,
                        agentCount = viewModel.agents.size,
                        onAdvanceRelease = viewModel::advancePipeline,
                        onInspectSlot = viewModel::inspectArtifact
                    )
                    ScreenSection.DIRECTORS -> DirectorsScreen(
                        channels = channels,
                        agents = viewModel.agents,
                        searchQuery = searchQuery,
                        onSearchQueryChange = viewModel::setChannelSearchQuery,
                        onAddChannel = viewModel::addChannel,
                        onInspectSlot = viewModel::inspectArtifact
                    )
                    ScreenSection.SCHEDULE -> ScheduleScreen(
                        channels = channels,
                        schedules = schedules,
                        selectedAgentId = selectedAgentId,
                        onSelectAgent = viewModel::selectAgent,
                        onSaveSchedule = viewModel::updateSchedule,
                        onPreviewPlan = viewModel::previewSchedulePlan,
                        onRunSchedulerNow = viewModel::runSchedulerNow,
                        feedbackMessage = schedulerFeedback,
                        onClearFeedback = viewModel::clearSchedulerFeedback
                    )
                    ScreenSection.COMMUNICATION -> CommunicationScreen(
                        channels = channels,
                        messages = messages,
                        selectedAgentId = selectedAgentId,
                        onSelectAgent = viewModel::selectAgent,
                        onSendMessage = viewModel::sendDirectorMessage
                    )
                    ScreenSection.MEMORY -> MemoryScreen(
                        channels = channels,
                        charters = charters,
                        selectedAgentId = selectedAgentId,
                        onSelectAgent = viewModel::selectAgent
                    )
                    ScreenSection.PRODUCTION -> ProductionScreen(
                        channels = channels,
                        releases = releases,
                        onStartProduction = viewModel::startProduction,
                        onAdvanceStage = viewModel::advancePipeline
                    )
                    ScreenSection.JOBS -> JobsScreen(
                        jobs = jobs,
                        currentFilter = jobStatusFilter,
                        onFilterChange = viewModel::setJobStatusFilter,
                        onPauseJob = viewModel::pauseJob,
                        onResumeJob = viewModel::resumeJob,
                        onCancelJob = viewModel::cancelJob
                    )
                    ScreenSection.PROVIDERS -> ProvidersQuotasScreen(
                        providers = providers
                    )
                    ScreenSection.CONNECTIONS -> ConnectionsScreen(
                        connections = platformConnections,
                        onUpdateSlot = viewModel::updateConnectionSlot
                    )
                    ScreenSection.APPROVALS -> ApprovalsScreen(
                        approvals = approvals,
                        onApprove = viewModel::approveItem,
                        onReject = viewModel::rejectItem
                    )
                    ScreenSection.EVIDENCE -> EvidenceScreen(
                        events = evidenceEvents,
                        currentFilter = evidenceFilter,
                        onFilterChange = viewModel::setEvidenceFilter
                    )
                    ScreenSection.HERMES -> HermesScreen(
                        decisions = hermesDecisions
                    )
                    ScreenSection.SETTINGS -> SettingsScreen(
                        owner = owner,
                        storageMode = viewModel.storageMode,
                        storageStatus = viewModel.storageStatus,
                        onLogout = viewModel::logout,
                        onResetToCanonical = viewModel::resetToCanonical
                    )
                }

                // Artifact inspection dialog
                if (inspectionData != null) {
                    InspectionDialog(
                        data = inspectionData!!,
                        onDismiss = viewModel::dismissInspection
                    )
                }
            }
        }
    }
}
