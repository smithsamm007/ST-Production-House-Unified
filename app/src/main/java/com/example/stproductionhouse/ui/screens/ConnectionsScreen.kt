package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.PlatformConnection
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun ConnectionsScreen(
    connections: List<PlatformConnection>,
    onUpdateSlot: (connectionId: String, status: String, locator: String) -> Unit,
    modifier: Modifier = Modifier
) {
    var editingSlot by remember { mutableStateOf<PlatformConnection?>(null) }
    var newLocator by remember { mutableStateOf("") }
    var newStatus by remember { mutableStateOf("sandbox_verified") }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "SECRETS & SOCIAL CONNECTION SLOTS (Rule 16 & 17)",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Every director possesses isolated connection slots. Opaque secret-manager locators (vault://...) only — no plaintext keys or cross-agent borrowing.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        items(connections) { slot ->
            val statusType = when (slot.status) {
                "live_authenticated" -> StatusType.OK
                "sandbox_verified" -> StatusType.INFO
                else -> StatusType.WARN
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
                                text = "${slot.platform} Connection Slot",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.5.sp
                            )
                            Text(
                                text = "Director ${slot.agentId} • Slot Isolation Enforced",
                                color = AccentCyan,
                                fontSize = 11.sp
                            )
                        }
                        StatusPill(text = slot.status.replace("_", " "), statusType = statusType)
                    }

                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(PanelDarkVariant, RoundedCornerShape(6.dp))
                            .padding(8.dp)
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("Opaque Locator:", color = TextMuted, fontSize = 9.5.sp, fontWeight = FontWeight.Bold)
                            Text(
                                text = slot.locator,
                                color = if (slot.status == "unconfigured") TextMuted else StatusOk,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Last verified: ${slot.lastVerified}",
                            color = TextMuted,
                            fontSize = 10.5.sp
                        )

                        OutlinedButton(
                            onClick = {
                                editingSlot = slot
                                newLocator = slot.locator
                                newStatus = slot.status
                            },
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                            modifier = Modifier.testTag("edit_slot_${slot.id}")
                        ) {
                            Text("Configure Slot", fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }

    if (editingSlot != null) {
        val slot = editingSlot!!
        AlertDialog(
            onDismissRequest = { editingSlot = null },
            title = { Text("Configure ${slot.platform} Slot for ${slot.agentId}", color = TextPrimary, fontWeight = FontWeight.Bold) },
            containerColor = PanelDark,
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Rule 4: Provider secrets belong in an external secret manager. Enter an opaque secret locator (e.g. vault://stph-secrets/${slot.agentId}/${slot.platform.lowercase()}-token).",
                        color = TextMuted,
                        fontSize = 11.5.sp
                    )

                    OutlinedTextField(
                        value = newLocator,
                        onValueChange = { newLocator = it },
                        label = { Text("Vault Locator URL") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = AccentBlue),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Text("Status Selection:", color = TextMuted, fontSize = 11.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = newStatus == "sandbox_verified",
                            onClick = { newStatus = "sandbox_verified" },
                            label = { Text("Sandbox", fontSize = 11.sp) }
                        )
                        FilterChip(
                            selected = newStatus == "live_authenticated",
                            onClick = { newStatus = "live_authenticated" },
                            label = { Text("Live Auth", fontSize = 11.sp) }
                        )
                        FilterChip(
                            selected = newStatus == "unconfigured",
                            onClick = { newStatus = "unconfigured" },
                            label = { Text("Unconfigured", fontSize = 11.sp) }
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        onUpdateSlot(slot.id, newStatus, newLocator.ifBlank { "vault://stph-secrets/unconfigured" })
                        editingSlot = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue)
                ) {
                    Text("Save Slot")
                }
            },
            dismissButton = {
                TextButton(onClick = { editingSlot = null }) {
                    Text("Cancel", color = TextMuted)
                }
            }
        )
    }
}
