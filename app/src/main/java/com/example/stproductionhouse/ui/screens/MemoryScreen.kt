package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.CreativeCharter
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun MemoryScreen(
    channels: List<Channel>,
    charters: Map<String, CreativeCharter>,
    selectedAgentId: String,
    onSelectAgent: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val currentCharter = charters[selectedAgentId]

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "DIRECTOR MEMORY & CREATIVE CHARTER",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Universe rules, continuity guidelines, pacing parameters, and narrative lore for each production director.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Director channel selector
        item {
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
                                text = ch.displayName.take(10) + "…",
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

        if (currentCharter != null) {
            item {
                Card(
                    colors = CardDefaults.cardColors(containerColor = PanelDark),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Universe Creative Charter",
                                color = AccentCyan,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                            StatusPill(text = "Director $selectedAgentId", statusType = StatusType.INFO)
                        }

                        CharterSection(title = "LOGLINE", content = currentCharter.logline)
                        CharterSection(title = "PREMISE & SETTING", content = currentCharter.premise)
                        CharterSection(title = "VISUAL STYLE & PALETTE", content = currentCharter.visualStyle)
                        CharterSection(title = "PACING & RHYTHM", content = currentCharter.pacing)
                        CharterSection(title = "TARGET AUDIENCE", content = currentCharter.targetAudience)
                    }
                }
            }

            item {
                Card(
                    colors = CardDefaults.cardColors(containerColor = PanelDark),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = "Character Continuity & Non-Negotiable Rules",
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp
                        )
                        currentCharter.continuityRules.forEach { rule ->
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(PanelDarkVariant)
                                    .border(1.dp, BorderDark, RoundedCornerShape(8.dp))
                                    .padding(10.dp)
                            ) {
                                Text(
                                    text = rule,
                                    color = TextPrimary,
                                    fontSize = 12.sp,
                                    lineHeight = 17.sp
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CharterSection(title: String, content: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            text = title,
            color = TextMuted,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp
        )
        Text(
            text = content,
            color = TextPrimary,
            fontSize = 13.sp,
            lineHeight = 18.sp
        )
    }
}
