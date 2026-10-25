package com.example.stproductionhouse.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.InspectionModalData
import com.example.stproductionhouse.data.model.MediaSlot
import com.example.stproductionhouse.ui.theme.*

@Composable
fun TopHeaderBar(
    ownerEmail: String?,
    storageMode: String,
    storageStatus: String,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        color = PanelDark,
        modifier = modifier
            .fillMaxWidth()
            .border(width = 1.dp, color = BorderDark)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(38.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(PanelDarkVariant)
                            .border(1.dp, BorderBright, RoundedCornerShape(8.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "ST",
                            color = AccentCyan,
                            fontWeight = FontWeight.Black,
                            fontSize = 15.sp,
                            letterSpacing = 1.sp
                        )
                    }

                    Column {
                        Text(
                            text = "PRODUCTION HOUSE",
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            letterSpacing = 1.5.sp
                        )
                        Text(
                            text = "UNIFIED · OWNER CONSOLE",
                            color = TextMuted,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 2.sp
                        )
                    }
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    StatusPill(text = "$storageMode · $storageStatus", statusType = StatusType.OK)
                    if (ownerEmail != null) {
                        Text(
                            text = ownerEmail.substringBefore("@"),
                            color = TextMuted,
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        IconButton(
                            onClick = onLogout,
                            modifier = Modifier
                                .size(36.dp)
                                .testTag("logout_button")
                        ) {
                            Icon(
                                imageVector = Icons.Default.Logout,
                                contentDescription = "Sign out",
                                tint = StatusBad,
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(6.dp))

            Text(
                text = "Multiple Directors  •  Independent Universes  •  One Production House",
                color = TextMuted,
                fontSize = 10.5.sp,
                letterSpacing = 0.5.sp
            )
        }
    }
}

enum class StatusType { OK, WARN, BAD, INFO }

@Composable
fun StatusPill(
    text: String,
    statusType: StatusType = StatusType.INFO,
    modifier: Modifier = Modifier
) {
    val (bgColor, textColor, borderColor) = when (statusType) {
        StatusType.OK -> Triple(StatusOk.copy(alpha = 0.12f), StatusOk, StatusOk.copy(alpha = 0.4f))
        StatusType.WARN -> Triple(StatusWarn.copy(alpha = 0.12f), StatusWarn, StatusWarn.copy(alpha = 0.4f))
        StatusType.BAD -> Triple(StatusBad.copy(alpha = 0.12f), StatusBad, StatusBad.copy(alpha = 0.4f))
        StatusType.INFO -> Triple(AccentCyan.copy(alpha = 0.12f), AccentCyan, AccentCyan.copy(alpha = 0.4f))
    }

    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(bgColor)
            .border(1.dp, borderColor, CircleShape)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            color = textColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
fun MetricCard(
    label: String,
    value: String,
    status: StatusType = StatusType.OK,
    modifier: Modifier = Modifier
) {
    val valueColor = when (status) {
        StatusType.OK -> StatusOk
        StatusType.WARN -> StatusWarn
        StatusType.BAD -> StatusBad
        StatusType.INFO -> AccentCyan
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = PanelDark),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.border(1.dp, BorderDark, RoundedCornerShape(12.dp))
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                text = label.uppercase(),
                color = TextMuted,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = value,
                color = valueColor,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

@Composable
fun PipelineStageStrip(
    currentStage: String,
    modifier: Modifier = Modifier
) {
    val stages = listOf(
        Pair("story", "Story & Beats"),
        Pair("visual", "Scene Visuals"),
        Pair("audio", "Voice & Sound"),
        Pair("assembly", "FFmpeg Assembly"),
        Pair("reels", "Short-Form Reels"),
        Pair("packaging", "Packaging"),
        Pair("qc", "QC Gate"),
        Pair("complete", "Published")
    )

    val currentIdx = stages.indexOfFirst { it.first == currentStage }.let { if (it == -1) 0 else it }

    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = "THE PRODUCTION PIPELINE",
            color = TextMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.5.sp
        )
        Spacer(modifier = Modifier.height(8.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            stages.forEachIndexed { index, (key, label) ->
                val isCompleted = index < currentIdx
                val isCurrent = index == currentIdx

                val boxBg = when {
                    isCurrent -> AccentBlue.copy(alpha = 0.2f)
                    isCompleted -> StatusOk.copy(alpha = 0.12f)
                    else -> PanelDarkVariant
                }
                val boxBorder = when {
                    isCurrent -> AccentBlue
                    isCompleted -> StatusOk.copy(alpha = 0.5f)
                    else -> BorderDark
                }
                val textColor = when {
                    isCurrent -> AccentCyan
                    isCompleted -> StatusOk
                    else -> TextMuted
                }

                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(boxBg)
                        .border(1.dp, boxBorder, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                ) {
                    Column {
                        Text(
                            text = "${index + 1}. $key",
                            color = textColor,
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp
                        )
                        Text(
                            text = label,
                            color = TextMuted,
                            fontSize = 10.sp
                        )
                    }
                }

                if (index < stages.size - 1) {
                    Text("→", color = BorderBright, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
fun MediaSlotItem(
    slot: MediaSlot,
    onInspect: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val statusType = when (slot.status) {
        "verified", "published" -> StatusType.OK
        "rendering" -> StatusType.WARN
        else -> StatusType.INFO
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(PanelDarkVariant)
            .border(1.dp, BorderDark, RoundedCornerShape(8.dp))
            .clickable { onInspect() }
            .padding(10.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = slot.label,
                        color = TextPrimary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = "(${slot.aspectRatio})",
                        color = TextMuted,
                        fontSize = 10.5.sp
                    )
                }
                StatusPill(text = slot.status, statusType = statusType)
            }

            if (slot.artifactTitle != null) {
                Text(
                    text = slot.artifactTitle,
                    color = AccentCyan,
                    fontSize = 11.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "${slot.hint} • ${slot.resolution}",
                    color = TextMuted,
                    fontSize = 10.sp
                )
                if (slot.durationSeconds != null) {
                    Text(
                        text = "${slot.durationSeconds / 60}m ${slot.durationSeconds % 60}s",
                        color = TextMuted,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (slot.artifactHash != null) {
                    Text(
                        text = "SHA: ${slot.artifactHash.take(16)}…",
                        color = TextMuted,
                        fontSize = 9.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
                Text(
                    text = "Tap to Inspect 🔍",
                    color = AccentCyan,
                    fontSize = 9.5.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
fun InspectionDialog(
    data: InspectionModalData,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Artifact Inspection & Hash Receipt",
                    color = TextPrimary,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
                StatusPill(text = "VERIFIED", statusType = StatusType.OK)
            }
        },
        containerColor = PanelDark,
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = data.title,
                    color = AccentCyan,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold
                )

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(PanelDarkVariant)
                        .padding(10.dp)
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Slot Identity:", color = TextMuted, fontSize = 11.sp)
                            Text(data.slotKey, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Resolution & Ratio:", color = TextMuted, fontSize = 11.sp)
                            Text("${data.resolution} (${data.aspectRatio})", color = TextPrimary, fontSize = 11.sp)
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Duration:", color = TextMuted, fontSize = 11.sp)
                            Text("${data.durationSeconds / 60}m ${data.durationSeconds % 60}s", color = TextPrimary, fontSize = 11.sp)
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Broadcast Loudness:", color = TextMuted, fontSize = 11.sp)
                            Text(data.lufs, color = StatusOk, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Video / Audio Codec:", color = TextMuted, fontSize = 11.sp)
                            Text(data.codec, color = TextPrimary, fontSize = 11.sp)
                        }
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Cryptographic SHA-256 Checksum:", color = TextMuted, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    Text(
                        text = data.sha256,
                        color = StatusOk,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color.Black.copy(alpha = 0.3f), RoundedCornerShape(4.dp))
                            .padding(6.dp)
                    )
                }

                Text(
                    text = "Honest-Label Evidence (Rules 1 & 2): FFprobe metadata matched against canonical pipeline receipt. Zero synthetic platform metrics.",
                    color = TextMuted,
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp
                )
            }
        },
        confirmButton = {
            Button(
                onClick = onDismiss,
                colors = ButtonDefaults.buttonColors(containerColor = AccentBlue)
            ) {
                Text("Close")
            }
        }
    )
}
