package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
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
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.DirectorMessage
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun CommunicationScreen(
    channels: List<Channel>,
    messages: List<DirectorMessage>,
    selectedAgentId: String,
    onSelectAgent: (String) -> Unit,
    onSendMessage: (agentId: String, kind: String, sender: String, body: String) -> Unit,
    modifier: Modifier = Modifier
) {
    val filteredMessages = messages.filter { it.agentId == selectedAgentId }
    val currentChannel = channels.find { it.agentId == selectedAgentId }

    var messageBody by remember { mutableStateOf("") }
    var selectedKind by remember { mutableStateOf("conversation") }
    var selectedSender by remember { mutableStateOf("owner") }

    val quickTemplates = listOf(
        "Review episode pacing and tense climaxes",
        "Request 3 alternative visual keyframe styles",
        "Approve -14 LUFS soundscape master",
        "Enforce strict non-Euclidean continuity rule"
    )

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Column {
            Text(
                text = "DIRECTOR COMMUNICATION STUDIO",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 17.sp
            )
            Text(
                text = "Persistent window per director. Messages carry explicit semantics: conversation | proposal | instruction | decision. Never triggers unapproved publishing.",
                color = TextMuted,
                fontSize = 12.sp
            )
        }

        // Director channel selector
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

        // Active Director Context Bar
        if (currentChannel != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(PanelDarkVariant)
                    .border(1.dp, BorderBright, RoundedCornerShape(8.dp))
                    .padding(horizontal = 12.dp, vertical = 6.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Active: Director ${currentChannel.agentId} (${currentChannel.displayName})",
                        color = AccentCyan,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = "Charter: ${currentChannel.language}",
                        color = TextMuted,
                        fontSize = 10.5.sp
                    )
                }
            }
        }

        // Messages list
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(PanelDark)
                .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (filteredMessages.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        Text("No messages recorded for Director $selectedAgentId yet.", color = TextMuted, fontSize = 13.sp)
                    }
                }
            } else {
                items(filteredMessages) { msg ->
                    val isOwner = msg.sender == "owner"
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (isOwner) PanelDarkVariant else Color(0xFF0F1A2E))
                            .border(1.dp, if (isOwner) BorderDark else BorderBright, RoundedCornerShape(10.dp))
                            .padding(12.dp)
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Text(
                                        text = if (isOwner) "Owner (Console)" else "Director ${msg.agentId}",
                                        color = if (isOwner) TextPrimary else AccentCyan,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 12.sp
                                    )
                                    StatusPill(text = msg.kind, statusType = when (msg.kind) {
                                        "decision" -> StatusType.OK
                                        "proposal" -> StatusType.WARN
                                        "instruction" -> StatusType.INFO
                                        else -> StatusType.INFO
                                    })
                                }
                                Text(
                                    text = msg.timestamp,
                                    color = TextMuted,
                                    fontSize = 10.sp
                                )
                            }

                            Text(
                                text = msg.body,
                                color = TextPrimary,
                                fontSize = 13.sp,
                                lineHeight = 18.sp
                            )
                        }
                    }
                }
            }
        }

        // Quick template chips
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            quickTemplates.forEach { template ->
                AssistChip(
                    onClick = {
                        messageBody = template
                        selectedKind = "instruction"
                    },
                    label = { Text(template, fontSize = 10.5.sp) },
                    colors = AssistChipDefaults.assistChipColors(containerColor = PanelDarkVariant)
                )
            }
        }

        // Composer
        Card(
            colors = CardDefaults.cardColors(containerColor = PanelDark),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
        ) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Semantics chip
                    listOf("conversation", "proposal", "instruction", "decision").forEach { kind ->
                        FilterChip(
                            selected = selectedKind == kind,
                            onClick = { selectedKind = kind },
                            label = { Text(kind, fontSize = 11.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = AccentBlue.copy(alpha = 0.25f),
                                selectedLabelColor = AccentCyan
                            )
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Sender:", color = TextMuted, fontSize = 11.sp)
                        FilterChip(
                            selected = selectedSender == "owner",
                            onClick = { selectedSender = "owner" },
                            label = { Text("Owner", fontSize = 11.sp) }
                        )
                        FilterChip(
                            selected = selectedSender == "director",
                            onClick = { selectedSender = "director" },
                            label = { Text("Director", fontSize = 11.sp) }
                        )
                    }

                    Text(
                        text = "${messageBody.length}/8000",
                        color = TextMuted,
                        fontSize = 10.sp
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedTextField(
                        value = messageBody,
                        onValueChange = { if (it.length <= 8000) messageBody = it },
                        placeholder = { Text("Record message body...", color = TextMuted) },
                        maxLines = 3,
                        modifier = Modifier
                            .weight(1f)
                            .testTag("message_input")
                    )

                    IconButton(
                        onClick = {
                            if (messageBody.isNotBlank()) {
                                onSendMessage(selectedAgentId, selectedKind, selectedSender, messageBody.trim())
                                messageBody = ""
                            }
                        },
                        colors = IconButtonDefaults.iconButtonColors(containerColor = AccentBlue),
                        modifier = Modifier
                            .size(44.dp)
                            .testTag("send_message_btn")
                    ) {
                        Icon(Icons.Default.Send, contentDescription = "Send", tint = BgDark, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}
