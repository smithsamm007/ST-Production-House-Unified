package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.DirectorSchedule
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun ScheduleScreen(
    channels: List<Channel>,
    schedules: Map<String, DirectorSchedule>,
    selectedAgentId: String,
    onSelectAgent: (String) -> Unit,
    onSaveSchedule: (DirectorSchedule) -> Unit,
    onPreviewPlan: (String) -> Unit,
    onRunSchedulerNow: (String) -> Unit,
    feedbackMessage: String?,
    onClearFeedback: () -> Unit,
    modifier: Modifier = Modifier
) {
    val currentSchedule = schedules[selectedAgentId] ?: DirectorSchedule(selectedAgentId)

    var duration by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.mainEpisodeDuration) }
    var epsPerDay by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.episodesPerDay) }
    var days by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.productionDays) }
    var startTime by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.preferredStartTime) }
    var timezone by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.timezone) }
    var enabled by remember(selectedAgentId, currentSchedule) { mutableStateOf(currentSchedule.enabled) }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "EPISODE & PRODUCTION SCHEDULE (sql/029)",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Each director owns its settings: duration, episodes per day, production days, start time, and timezone. Scheduler runs queue planned episodes into the approval pipeline.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Director selector tabs
        item {
            Text("Select Director Channel:", color = TextMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Spacer(modifier = Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                channels.forEach { ch ->
                    val isSelected = ch.agentId == selectedAgentId
                    Surface(
                        color = if (isSelected) AccentBlue.copy(alpha = 0.2f) else PanelDark,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .weight(1f)
                            .border(1.dp, if (isSelected) AccentBlue else BorderDark, RoundedCornerShape(8.dp))
                            .clickable { onSelectAgent(ch.agentId) }
                    ) {
                        Column(modifier = Modifier.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = ch.displayName.take(12) + "…",
                                color = if (isSelected) AccentCyan else TextPrimary,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = ch.agentId,
                                color = TextMuted,
                                fontSize = 10.sp
                            )
                        }
                    }
                }
            }
        }

        // Form Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text(
                        text = "Schedule Configuration for $selectedAgentId",
                        color = AccentCyan,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )

                    // Episode duration options
                    Column {
                        Text("Main Episode Duration:", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(1800 to "30 minutes", 2400 to "40 minutes", 3000 to "50 minutes").forEach { (sec, label) ->
                                val selected = duration == sec
                                FilterChip(
                                    selected = selected,
                                    onClick = { duration = sec },
                                    label = { Text(label, fontSize = 12.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = AccentBlue.copy(alpha = 0.25f),
                                        selectedLabelColor = AccentCyan
                                    )
                                )
                            }
                        }
                    }

                    // Episodes per day
                    Column {
                        Text("Episodes Per Day ($epsPerDay):", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Slider(
                            value = epsPerDay.toFloat(),
                            onValueChange = { epsPerDay = it.toInt() },
                            valueRange = 1f..6f,
                            steps = 4,
                            colors = SliderDefaults.colors(thumbColor = AccentBlue, activeTrackColor = AccentBlue)
                        )
                    }

                    // Production days
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("Production Days:", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                TextButton(onClick = { days = setOf(1, 2, 3, 4, 5, 6, 7) }) {
                                    Text("Every day", fontSize = 11.sp, color = AccentCyan)
                                }
                                TextButton(onClick = { days = setOf(1, 2, 3, 4, 5) }) {
                                    Text("Mon–Fri", fontSize = 11.sp, color = AccentCyan)
                                }
                            }
                        }

                        val dayNames = listOf(1 to "Mon", 2 to "Tue", 3 to "Wed", 4 to "Thu", 5 to "Fri", 6 to "Sat", 7 to "Sun")
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            dayNames.forEach { (d, name) ->
                                val isChecked = days.contains(d)
                                FilterChip(
                                    selected = isChecked,
                                    onClick = {
                                        days = if (isChecked) days - d else days + d
                                    },
                                    label = { Text(name, fontSize = 11.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = AccentBlue.copy(alpha = 0.3f),
                                        selectedLabelColor = AccentCyan
                                    ),
                                    modifier = Modifier.weight(1f)
                                )
                            }
                        }
                    }

                    // Time and timezone
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        OutlinedTextField(
                            value = startTime,
                            onValueChange = { startTime = it },
                            label = { Text("Start Time") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = timezone,
                            onValueChange = { timezone = it },
                            label = { Text("Timezone (IANA)") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }

                    // Schedule enabled toggle
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Schedule Enabled", color = TextPrimary, fontWeight = FontWeight.Medium, fontSize = 13.sp)
                            Text("Unchecked = Paused production", color = TextMuted, fontSize = 11.sp)
                        }
                        Switch(
                            checked = enabled,
                            onCheckedChange = { enabled = it },
                            colors = SwitchDefaults.colors(checkedThumbColor = AccentCyan, checkedTrackColor = AccentBlue)
                        )
                    }

                    // Action buttons
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = {
                                val updated = DirectorSchedule(
                                    agentId = selectedAgentId,
                                    mainEpisodeDuration = duration,
                                    episodesPerDay = epsPerDay,
                                    productionDays = days,
                                    preferredStartTime = startTime,
                                    timezone = timezone,
                                    enabled = enabled
                                )
                                onSaveSchedule(updated)
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                            modifier = Modifier
                                .weight(1f)
                                .testTag("save_schedule_btn")
                        ) {
                            Text("Save Schedule")
                        }

                        OutlinedButton(
                            onClick = { onPreviewPlan(selectedAgentId) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Preview Plan", fontSize = 12.sp)
                        }
                    }

                    OutlinedButton(
                        onClick = { onRunSchedulerNow(selectedAgentId) },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = StatusOk),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("run_scheduler_now_btn")
                    ) {
                        Text("Run Scheduler Now (Queues Due Slot)")
                    }
                }
            }
        }

        // Feedback / Result banner
        if (feedbackMessage != null) {
            item {
                Card(
                    colors = CardDefaults.cardColors(containerColor = PanelDarkVariant),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, BorderBright, RoundedCornerShape(10.dp))
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("Scheduler Execution Result", color = AccentCyan, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            TextButton(onClick = onClearFeedback) {
                                Text("Dismiss", color = TextMuted, fontSize = 11.sp)
                            }
                        }
                        Text(
                            text = feedbackMessage,
                            color = TextPrimary,
                            fontSize = 12.5.sp,
                            lineHeight = 18.sp
                        )
                    }
                }
            }
        }
    }
}
