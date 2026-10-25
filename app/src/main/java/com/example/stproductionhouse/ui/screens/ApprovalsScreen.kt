package com.example.stproductionhouse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.example.stproductionhouse.data.model.ApprovalItem
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun ApprovalsScreen(
    approvals: List<ApprovalItem>,
    onApprove: (String) -> Unit,
    onReject: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Column {
                Text(
                    text = "LIVE PUBLISHING APPROVALS (Rule 7)",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Live publishing requires an explicit, unexpired owner approval tied to the exact artifact hash, destination, caption, affiliate links, and disclosure.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        if (approvals.isEmpty()) {
            item {
                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("No publication approvals pending.", color = TextMuted, fontSize = 13.sp)
                }
            }
        } else {
            items(approvals) { item ->
                val statusType = when (item.status) {
                    "approved" -> StatusType.OK
                    "rejected" -> StatusType.BAD
                    else -> StatusType.WARN
                }

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
                                    text = item.title,
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 15.sp
                                )
                                Text(
                                    text = "${item.channelName} • Destination: ${item.destination}",
                                    color = AccentCyan,
                                    fontSize = 12.sp
                                )
                            }
                            StatusPill(text = item.status, statusType = statusType)
                        }

                        // Artifact hash
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .background(PanelDarkVariant)
                                .padding(8.dp)
                        ) {
                            Text(
                                text = "Artifact Hash: ${item.artifactHash}",
                                color = TextMuted,
                                fontSize = 10.5.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }

                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Caption:", color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            Text(item.caption, color = TextPrimary, fontSize = 12.5.sp)
                        }

                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Disclosure:", color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            Text(item.disclosure, color = TextMuted, fontSize = 12.sp)
                        }

                        if (item.status == "pending") {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                Button(
                                    onClick = { onApprove(item.id) },
                                    colors = ButtonDefaults.buttonColors(containerColor = StatusOk, contentColor = BgDark),
                                    modifier = Modifier
                                        .weight(1f)
                                        .testTag("approve_btn_${item.id}")
                                ) {
                                    Text("Approve for Live Release", fontWeight = FontWeight.Bold)
                                }

                                OutlinedButton(
                                    onClick = { onReject(item.id) },
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = StatusBad),
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Text("Reject")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
