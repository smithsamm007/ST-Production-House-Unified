package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import com.example.stproductionhouse.data.model.Owner
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun SettingsScreen(
    owner: Owner?,
    storageMode: String,
    storageStatus: String,
    onLogout: () -> Unit,
    onResetToCanonical: () -> Unit,
    modifier: Modifier = Modifier
) {
    var defaultPublishingMode by remember { mutableStateOf("dry_run") }
    var showResetDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "SETTINGS & SYSTEM CONFIGURATION",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Control plane configuration, storage runtime, publishing safety defaults, and owner profile.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Owner Profile Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Owner Identity", color = AccentCyan, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Email:", color = TextMuted, fontSize = 13.sp)
                        Text(owner?.email ?: "Not authenticated", color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Role:", color = TextMuted, fontSize = 13.sp)
                        StatusPill(text = owner?.role ?: "guest", statusType = StatusType.OK)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Session:", color = TextMuted, fontSize = 13.sp)
                        StatusPill(text = if (owner?.isAuthenticated == true) "Active (CSRF protected)" else "Expired", statusType = StatusType.OK)
                    }

                    Spacer(modifier = Modifier.height(6.dp))
                    Button(
                        onClick = onLogout,
                        colors = ButtonDefaults.buttonColors(containerColor = StatusBad.copy(alpha = 0.2f), contentColor = StatusBad),
                        modifier = Modifier.fillMaxWidth().testTag("logout_full_btn")
                    ) {
                        Text("Sign Out of Owner Console")
                    }
                }
            }
        }

        // Storage Engine Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Storage & Database Engine", color = AccentCyan, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Runtime Mode:", color = TextMuted, fontSize = 13.sp)
                        StatusPill(text = "$storageMode mode", statusType = StatusType.INFO)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Health Check:", color = TextMuted, fontSize = 13.sp)
                        StatusPill(text = storageStatus, statusType = StatusType.OK)
                    }
                    Text(
                        text = "Honest-Label Contract (AGENTS.md Rules 1–3): All operations are verifiable. No fake provider receipts or synthetic URLs are ever generated.",
                        color = TextMuted,
                        fontSize = 11.5.sp,
                        lineHeight = 16.sp
                    )

                    OutlinedButton(
                        onClick = { showResetDialog = true },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = StatusWarn),
                        modifier = Modifier.fillMaxWidth().testTag("reset_canonical_btn")
                    ) {
                        Text("Reset System to Canonical Seed Data")
                    }
                }
            }
        }

        // Publishing Policy Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Publishing Safety Policy (Rule 7)", color = AccentCyan, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Default Mode", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            Text("Safe dry run prevents accidental social dispatch", color = TextMuted, fontSize = 11.sp)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            FilterChip(
                                selected = defaultPublishingMode == "dry_run",
                                onClick = { defaultPublishingMode = "dry_run" },
                                label = { Text("Dry Run", fontSize = 11.sp) }
                            )
                            FilterChip(
                                selected = defaultPublishingMode == "live",
                                onClick = { defaultPublishingMode = "live" },
                                label = { Text("Live", fontSize = 11.sp) }
                            )
                        }
                    }
                }
            }
        }
    }

    if (showResetDialog) {
        AlertDialog(
            onDismissRequest = { showResetDialog = false },
            title = { Text("Confirm Reset to Canonical", color = TextPrimary, fontWeight = FontWeight.Bold) },
            containerColor = PanelDark,
            text = {
                Text(
                    text = "This will restore the 4 canonical channels, schedules, charters, initial jobs, and initial evidence ledger to default seed values.",
                    color = TextMuted,
                    fontSize = 13.sp
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        onResetToCanonical()
                        showResetDialog = false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = StatusWarn, contentColor = BgDark)
                ) {
                    Text("Confirm Reset")
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text("Cancel", color = TextMuted)
                }
            }
        )
    }
}
