package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.Agent
import com.example.stproductionhouse.data.model.Channel
import com.example.stproductionhouse.data.model.MediaSlot
import com.example.stproductionhouse.ui.components.*
import com.example.stproductionhouse.ui.theme.*

@Composable
fun DirectorsScreen(
    channels: List<Channel>,
    agents: List<Agent>,
    searchQuery: String,
    onSearchQueryChange: (String) -> Unit,
    onAddChannel: (slug: String, displayName: String, tagline: String, language: String, agentId: String, launchTitle: String) -> Unit,
    onInspectSlot: (MediaSlot, String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showDialog by remember { mutableStateOf(false) }

    var newSlug by remember { mutableStateOf("") }
    var newDisplayName by remember { mutableStateOf("") }
    var newTagline by remember { mutableStateOf("") }
    var newLanguage by remember { mutableStateOf("Hindi / English") }
    var selectedAgentId by remember { mutableStateOf(agents.firstOrNull()?.id ?: "agent-01") }
    var newLaunchTitle by remember { mutableStateOf("") }

    val filteredChannels = remember(channels, searchQuery) {
        if (searchQuery.isBlank()) channels
        else channels.filter {
            it.displayName.contains(searchQuery, ignoreCase = true) ||
            it.slug.contains(searchQuery, ignoreCase = true) ||
            it.language.contains(searchQuery, ignoreCase = true)
        }
    }

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
                        text = "DIRECTOR CHANNELS",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp
                    )
                    Text(
                        text = "Public channel branding only. Internal director identities stay server-side (Rule 15). Registered: ${agents.size}/50 cap.",
                        color = TextMuted,
                        fontSize = 12.sp
                    )
                }
                Button(
                    onClick = { showDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                    modifier = Modifier.testTag("add_channel_btn")
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("New Channel", fontSize = 12.sp)
                }
            }
        }

        // Search bar
        item {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = onSearchQueryChange,
                placeholder = { Text("Search channels by name, slug, language...", color = TextMuted) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextMuted) },
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = AccentBlue,
                    unfocusedBorderColor = BorderDark,
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary,
                    focusedContainerColor = PanelDark,
                    unfocusedContainerColor = PanelDark
                ),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth().testTag("channel_search_bar")
            )
        }

        items(filteredChannels) { channel ->
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
                                fontSize = 16.sp
                            )
                            Text(
                                text = "Director ${channel.agentId} • ${channel.language}",
                                color = AccentCyan,
                                fontSize = 12.sp
                            )
                        }
                        StatusPill(text = channel.slug, statusType = StatusType.INFO)
                    }

                    Text(
                        text = channel.tagline,
                        color = TextMuted,
                        fontSize = 13.sp
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        channel.activePlatforms.forEach { platform ->
                            Surface(
                                color = PanelDarkVariant,
                                shape = RoundedCornerShape(6.dp),
                                modifier = Modifier.border(1.dp, BorderBright, RoundedCornerShape(6.dp))
                            ) {
                                Text(
                                    text = platform,
                                    color = StatusOk,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                                )
                            }
                        }
                    }

                    Divider(color = BorderDark)

                    Text(
                        text = "Canonical Media Slots (Rule 8: One standalone Reel reservation) • Tap slot to inspect:",
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold
                    )

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

    if (showDialog) {
        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text("Register New Channel", color = TextPrimary, fontWeight = FontWeight.Bold) },
            containerColor = PanelDark,
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = newSlug,
                        onValueChange = { newSlug = it.lowercase().replace(" ", "-") },
                        label = { Text("Slug (e.g. sci-fi-chronicles)") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = newDisplayName,
                        onValueChange = { newDisplayName = it },
                        label = { Text("Display Name") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = newTagline,
                        onValueChange = { newTagline = it },
                        label = { Text("Tagline") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = newLanguage,
                        onValueChange = { newLanguage = it },
                        label = { Text("Language (e.g. Hindi, English)") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = newLaunchTitle,
                        onValueChange = { newLaunchTitle = it },
                        label = { Text("Launch Title / Pilot") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (newSlug.isNotBlank() && newDisplayName.isNotBlank()) {
                            onAddChannel(newSlug, newDisplayName, newTagline, newLanguage, selectedAgentId, newLaunchTitle.ifBlank { "$newDisplayName Pilot" })
                            showDialog = false
                            newSlug = ""
                            newDisplayName = ""
                            newTagline = ""
                            newLaunchTitle = ""
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue)
                ) {
                    Text("Create Channel")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) {
                    Text("Cancel", color = TextMuted)
                }
            }
        )
    }
}
