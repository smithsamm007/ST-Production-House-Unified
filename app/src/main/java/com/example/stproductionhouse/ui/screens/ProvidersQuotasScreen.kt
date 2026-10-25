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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.ProviderSlot
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun ProvidersQuotasScreen(
    providers: List<ProviderSlot>,
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
                    text = "PROVIDER STATUS & QUOTA LEDGER",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Rule 5 Contract: 3 private remote slots + 1 local open-source emergency slot per task policy. Never borrow cross-agent secrets.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Provider categories
        val categories = listOf("Visual", "Narration", "Assembly", "Publisher")
        categories.forEach { category ->
            val categoryProviders = providers.filter { it.category == category }

            item {
                Text(
                    text = "$category Providers".uppercase(),
                    color = AccentCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
            }

            items(categoryProviders) { p ->
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
                                    text = p.name,
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 14.sp
                                )
                                Text(
                                    text = p.tier,
                                    color = AccentCyan,
                                    fontSize = 11.sp
                                )
                            }
                            StatusPill(text = p.status, statusType = StatusType.OK)
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "Latency: ${p.latencyMs}ms",
                                color = TextMuted,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            Text(
                                text = "Daily Quota: ${p.dailyQuotaUsedPercent}%",
                                color = if (p.dailyQuotaUsedPercent > 80) StatusWarn else StatusOk,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                        }

                        LinearProgressIndicator(
                            progress = { p.dailyQuotaUsedPercent / 100f },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(5.dp)
                                .clip(RoundedCornerShape(3.dp)),
                            color = if (p.dailyQuotaUsedPercent > 80) StatusWarn else AccentBlue,
                            trackColor = BorderDark
                        )
                    }
                }
            }
        }

        // Rule 17 Opaque Secrets Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDarkVariant),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderBright, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Rule 17: Opaque Secrets & Safe Serialization",
                        color = StatusOk,
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp
                    )
                    Text(
                        text = "Real API keys, tokens, or passwords are never stored in plain text. Secret manager URLs (vault://stph-secrets/...) are used with strict field allowlists (DTO).",
                        color = TextMuted,
                        fontSize = 11.5.sp,
                        lineHeight = 16.sp
                    )
                }
            }
        }
    }
}
