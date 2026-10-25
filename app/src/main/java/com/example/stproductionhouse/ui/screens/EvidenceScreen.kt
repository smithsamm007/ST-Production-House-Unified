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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.EvidenceEvent
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun EvidenceScreen(
    events: List<EvidenceEvent>,
    currentFilter: String,
    onFilterChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val filters = listOf("ALL", "QC", "ASSEMBLY", "AUDIO", "SCHEDULE", "COMMUNICATION", "APPROVAL")

    val filteredEvents = remember(events, currentFilter) {
        if (currentFilter == "ALL") events
        else events.filter {
            it.eventType.contains(currentFilter, ignoreCase = true) ||
            it.stage.contains(currentFilter, ignoreCase = true)
        }
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
                    text = "DURABLE EVIDENCE LEDGER (Rules 1 & 2)",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Never claim an execution occurred without durable evidence. Zero fake receipts or mock platform IDs. Filterable cryptographic audit trail.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Filter chips
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                filters.forEach { f ->
                    val isSelected = currentFilter == f
                    FilterChip(
                        selected = isSelected,
                        onClick = { onFilterChange(f) },
                        label = { Text(f, fontSize = 11.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = AccentBlue.copy(alpha = 0.25f),
                            selectedLabelColor = AccentCyan
                        )
                    )
                }
            }
        }

        if (filteredEvents.isEmpty()) {
            item {
                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("No evidence events matching filter '$currentFilter'.", color = TextMuted, fontSize = 13.sp)
                }
            }
        } else {
            items(filteredEvents) { ev ->
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
                                    text = ev.eventType,
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.5.sp
                                )
                                Text(
                                    text = "Director ${ev.agentId} • ${ev.channelSlug} • Stage: ${ev.stage.uppercase()}",
                                    color = AccentCyan,
                                    fontSize = 11.sp
                                )
                            }
                            StatusPill(text = "VERIFIED", statusType = StatusType.OK)
                        }

                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .background(PanelDarkVariant)
                                .padding(8.dp)
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(
                                    text = "Receipt: ${ev.verificationReceipt}",
                                    color = StatusOk,
                                    fontSize = 10.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = "Hash: ${ev.artifactHash}",
                                    color = TextMuted,
                                    fontSize = 10.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "Timestamp: ${ev.timestamp}",
                                color = TextMuted,
                                fontSize = 10.5.sp
                            )
                            Text(
                                text = "Event ID: ${ev.id.take(8)}",
                                color = TextMuted,
                                fontSize = 10.5.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }
                    }
                }
            }
        }
    }
}
