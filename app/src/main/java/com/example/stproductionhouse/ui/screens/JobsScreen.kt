package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.ProductionJob
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun JobsScreen(
    jobs: List<ProductionJob>,
    currentFilter: String,
    onFilterChange: (String) -> Unit,
    onPauseJob: (String) -> Unit,
    onResumeJob: (String) -> Unit,
    onCancelJob: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val filters = listOf("ALL", "RUNNING", "QUEUED", "WAITING_FOR_QUOTA", "WAITING_FOR_APPROVAL", "SUCCEEDED", "FAILED")

    val filteredJobs = remember(jobs, currentFilter) {
        if (currentFilter == "ALL") jobs
        else jobs.filter { it.status.equals(currentFilter, ignoreCase = true) }
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "ACTIVE PRODUCTION JOBS",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Job lifecycle & checkpoint control (sql/010 + sql/017). Queue workers execute with durable leases, retry recovery, and quota limits.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Filter chips row
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                filters.forEach { filter ->
                    val isSelected = currentFilter == filter
                    FilterChip(
                        selected = isSelected,
                        onClick = { onFilterChange(filter) },
                        label = { Text(filter.replace("_", " "), fontSize = 11.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = AccentBlue.copy(alpha = 0.25f),
                            selectedLabelColor = AccentCyan
                        )
                    )
                }
            }
        }

        if (filteredJobs.isEmpty()) {
            item {
                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("No jobs matching status filter '$currentFilter'.", color = TextMuted, fontSize = 13.sp)
                }
            }
        } else {
            items(filteredJobs) { job ->
                val statusType = when (job.status) {
                    "running" -> StatusType.WARN
                    "succeeded" -> StatusType.OK
                    "failed" -> StatusType.BAD
                    "waiting_for_quota" -> StatusType.WARN
                    "waiting_for_approval" -> StatusType.INFO
                    else -> StatusType.INFO
                }

                Card(
                    colors = CardDefaults.cardColors(containerColor = PanelDark),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
                ) {
                    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column {
                                Text(
                                    text = job.capability.replace("_", " ").uppercase(),
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 14.sp
                                )
                                Text(
                                    text = "Director ${job.agentId} • ${job.createdAt}",
                                    color = AccentCyan,
                                    fontSize = 11.sp
                                )
                            }
                            StatusPill(text = job.status.replace("_", " "), statusType = statusType)
                        }

                        Text(
                            text = job.note,
                            color = TextMuted,
                            fontSize = 12.sp
                        )

                        if (job.status == "running" || job.status == "waiting_for_quota") {
                            LinearProgressIndicator(
                                progress = { job.progressPercent / 100f },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(5.dp)
                                    .clip(RoundedCornerShape(3.dp)),
                                color = AccentBlue,
                                trackColor = BorderDark
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "ID: ${job.id.take(8)}…",
                                color = TextMuted,
                                fontSize = 10.sp,
                                fontFamily = FontFamily.Monospace
                            )

                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (job.status == "running") {
                                    OutlinedButton(
                                        onClick = { onPauseJob(job.id) },
                                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                        modifier = Modifier.testTag("pause_job_${job.id}")
                                    ) {
                                        Text("Pause", fontSize = 11.sp)
                                    }
                                } else if (job.status == "paused") {
                                    OutlinedButton(
                                        onClick = { onResumeJob(job.id) },
                                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                        modifier = Modifier.testTag("resume_job_${job.id}")
                                    ) {
                                        Text("Resume", fontSize = 11.sp, color = StatusOk)
                                    }
                                }

                                if (job.status == "running" || job.status == "queued" || job.status == "waiting_for_quota") {
                                    OutlinedButton(
                                        onClick = { onCancelJob(job.id) },
                                        colors = ButtonDefaults.outlinedButtonColors(contentColor = StatusBad),
                                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                        modifier = Modifier.testTag("cancel_job_${job.id}")
                                    ) {
                                        Text("Cancel", fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
