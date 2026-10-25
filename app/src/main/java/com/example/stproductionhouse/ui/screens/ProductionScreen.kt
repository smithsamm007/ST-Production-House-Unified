package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.ProductionRelease
import com.example.stproductionhouse.ui.components.PipelineStageStrip
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun ProductionScreen(
    channels: List<Channel>,
    releases: List<ProductionRelease>,
    onStartProduction: (channelId: String, title: String, season: Int, episode: Int) -> Unit,
    onAdvanceStage: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showStartDialog by remember { mutableStateOf(false) }
    var selectedChannelId by remember { mutableStateOf(channels.firstOrNull()?.id ?: "") }
    var title by remember { mutableStateOf("") }
    var season by remember { mutableStateOf(1) }
    var episode by remember { mutableStateOf(1) }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "PRODUCTION PIPELINE ENGINE",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp
                    )
                    Text(
                        text = "Orchestrate end-to-end media production through the 8 canonical stages with verified evidence generation.",
                        color = TextMuted,
                        fontSize = 12.sp
                    )
                }

                Button(
                    onClick = { showStartDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                    modifier = Modifier.testTag("new_release_btn")
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("New Run", fontSize = 12.sp)
                }
            }
        }

        items(releases) { rel ->
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                text = rel.title,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                            Text(
                                text = "${rel.channelName} • S${rel.season} E${rel.episode}",
                                color = TextMuted,
                                fontSize = 11.5.sp
                            )
                        }

                        StatusPill(
                            text = rel.status.replace("_", " "),
                            statusType = when (rel.status) {
                                "in_production", "rendering" -> StatusType.WARN
                                "published" -> StatusType.OK
                                "review" -> StatusType.INFO
                                else -> StatusType.INFO
                            }
                        )
                    }

                    PipelineStageStrip(currentStage = rel.currentStage)

                    LinearProgressIndicator(
                        progress = { rel.stageProgress },
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
                            text = "Created: ${rel.createdAt}",
                            color = TextMuted,
                            fontSize = 11.sp
                        )

                        if (rel.currentStage != "complete") {
                            Button(
                                onClick = { onAdvanceStage(rel.id) },
                                colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                                modifier = Modifier.testTag("advance_pipeline_${rel.id}")
                            ) {
                                Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Execute Next Stage", fontSize = 12.sp)
                            }
                        } else {
                            StatusPill(text = "Production Certified", statusType = StatusType.OK)
                        }
                    }
                }
            }
        }
    }

    if (showStartDialog) {
        AlertDialog(
            onDismissRequest = { showStartDialog = false },
            title = { Text("Launch New Production Release", color = TextPrimary, fontWeight = FontWeight.Bold) },
            containerColor = PanelDark,
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Select Channel:", color = TextMuted, fontSize = 12.sp)
                    channels.forEach { ch ->
                        FilterChip(
                            selected = selectedChannelId == ch.id,
                            onClick = { selectedChannelId = ch.id },
                            label = { Text(ch.displayName, fontSize = 11.sp) }
                        )
                    }

                    OutlinedTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = { Text("Episode Title") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedTextField(
                            value = season.toString(),
                            onValueChange = { season = it.toIntOrNull() ?: 1 },
                            label = { Text("Season") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = episode.toString(),
                            onValueChange = { episode = it.toIntOrNull() ?: 1 },
                            label = { Text("Episode") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (title.isNotBlank()) {
                            onStartProduction(selectedChannelId, title.trim(), season, episode)
                            showStartDialog = false
                            title = ""
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue)
                ) {
                    Text("Start Run")
                }
            },
            dismissButton = {
                TextButton(onClick = { showStartDialog = false }) {
                    Text("Cancel", color = TextMuted)
                }
            }
        )
    }
}
