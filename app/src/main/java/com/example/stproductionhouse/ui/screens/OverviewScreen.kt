package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.MediaSlot
import com.example.stproductionhouse.data.model.ProductionJob
import com.example.stproductionhouse.data.model.ProductionRelease
import com.example.stproductionhouse.ui.components.*
import com.example.stproductionhouse.ui.theme.*

@Composable
fun OverviewScreen(
    channels: List<Channel>,
    releases: List<ProductionRelease>,
    jobs: List<ProductionJob>,
    agentCount: Int,
    onAdvanceRelease: (String) -> Unit,
    onInspectSlot: (MediaSlot, String) -> Unit,
    modifier: Modifier = Modifier
) {
    val activeJobsCount = jobs.count { it.status == "running" || it.status == "queued" }
    val succeededCount = jobs.count { it.status == "succeeded" }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Metrics strip
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                MetricCard(
                    label = "Active Jobs",
                    value = activeJobsCount.toString(),
                    status = if (activeJobsCount > 0) StatusType.WARN else StatusType.OK,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    label = "Channels",
                    value = channels.size.toString(),
                    status = StatusType.INFO,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    label = "Directors",
                    value = "$agentCount/50",
                    status = StatusType.OK,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    label = "Completed",
                    value = succeededCount.toString(),
                    status = StatusType.OK,
                    modifier = Modifier.weight(1f)
                )
            }
        }

        // Pipeline Strip Panel
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    val activeRelease = releases.firstOrNull()
                    PipelineStageStrip(
                        currentStage = activeRelease?.currentStage ?: "story"
                    )
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = "Every director runs an independent production team. Stages map directly to durable pipeline events.",
                        color = TextMuted,
                        fontSize = 11.5.sp
                    )
                }
            }
        }

        // Active Releases In Flight
        item {
            Text(
                text = "ACTIVE PRODUCTION RELEASES",
                color = TextMuted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp
            )
        }

        items(releases) { release ->
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
                                text = release.title,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                            Text(
                                text = "${release.channelName} • S${release.season} E${release.episode}",
                                color = TextMuted,
                                fontSize = 11.sp
                            )
                        }

                        StatusPill(
                            text = release.status.replace("_", " "),
                            statusType = when (release.status) {
                                "in_production", "rendering" -> StatusType.WARN
                                "published" -> StatusType.OK
                                "review" -> StatusType.INFO
                                else -> StatusType.INFO
                            }
                        )
                    }

                    LinearProgressIndicator(
                        progress = { release.stageProgress },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(6.dp)
                            .clip(RoundedCornerShape(3.dp)),
                        color = AccentBlue,
                        trackColor = BorderDark
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Stage: ${release.currentStage.uppercase()}",
                            color = AccentCyan,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold
                        )

                        if (release.currentStage != "complete") {
                            FilledTonalButton(
                                onClick = { onAdvanceRelease(release.id) },
                                colors = ButtonDefaults.filledTonalButtonColors(
                                    containerColor = PanelDarkVariant,
                                    contentColor = AccentCyan
                                ),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                                modifier = Modifier.testTag("advance_stage_btn_${release.id}")
                            ) {
                                Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(14.dp))
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("Advance Stage", fontSize = 11.sp)
                            }
                        }
                    }

                    // Execution log snippet
                    if (release.executionLog.isNotEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .background(PanelDarkVariant)
                                .padding(8.dp)
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text("Latest Stage Log:", color = TextMuted, fontSize = 9.5.sp, fontWeight = FontWeight.Bold)
                                Text(release.executionLog.last(), color = StatusOk, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                }
            }
        }

        // Director Channels & Media Slots
        item {
            Text(
                text = "DIRECTOR CHANNELS & CANONICAL MEDIA SLOTS (Tap slot to inspect)",
                color = TextMuted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp
            )
        }

        items(channels) { channel ->
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                text = channel.displayName,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                            Text(
                                text = "Director ${channel.agentId} • ${channel.language}",
                                color = AccentCyan,
                                fontSize = 11.sp
                            )
                        }
                        StatusPill(text = channel.slug, statusType = StatusType.INFO)
                    }

                    Text(
                        text = channel.tagline,
                        color = TextMuted,
                        fontSize = 12.sp
                    )

                    // 4 Canonical media slots grid
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        channel.slots.forEach { slot ->
                            MediaSlotItem(
                                slot = slot,
                                onInspect = { onInspectSlot(slot, channel.slug) }
                            )
                        }
                    }
                }
            }
        }
    }
}
