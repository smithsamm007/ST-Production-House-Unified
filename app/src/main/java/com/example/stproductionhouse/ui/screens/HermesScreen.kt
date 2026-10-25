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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.stproductionhouse.data.model.HermesDecision
import com.example.stproductionhouse.ui.components.StatusPill
import com.example.stproductionhouse.ui.components.StatusType
import com.example.stproductionhouse.ui.theme.*

@Composable
fun HermesScreen(
    decisions: List<HermesDecision>,
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
                    text = "HERMES · AI PRODUCTION MANAGER",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
                Text(
                    text = "Autonomous triage, authority matrix compliance, queue balancing, and provider failover coordination.",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }
        }

        // Mini Authority Matrix Card
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDarkVariant),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, BorderBright, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Hermes Authority Matrix", color = AccentCyan, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Text("• Tier 1 (Autonomous): Provider routing, retry recovery, cache hits, emergency fallback", color = TextPrimary, fontSize = 11.5.sp)
                    Text("• Tier 2 (Policy Governed): Production scheduling slots, reel generation reservations", color = TextPrimary, fontSize = 11.5.sp)
                    Text("• Tier 3 (Owner Required): Live social publishing, budget expansions, credential changes", color = TextPrimary, fontSize = 11.5.sp)
                }
            }
        }

        item {
            Text(
                text = "RECENT DECISIONS & TRIAGE LOGS",
                color = TextMuted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        items(decisions) { dec ->
            Card(
                colors = CardDefaults.cardColors(containerColor = PanelDark),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(12.dp))
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = dec.topic,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp
                        )
                        StatusPill(text = dec.authorityTier, statusType = StatusType.INFO)
                    }

                    Text(
                        text = "Decision: ${dec.decision}",
                        color = StatusOk,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 12.5.sp
                    )

                    Text(
                        text = "Rationale: ${dec.rationale}",
                        color = TextMuted,
                        fontSize = 12.sp
                    )

                    Text(
                        text = "Timestamp: ${dec.timestamp}",
                        color = TextMuted,
                        fontSize = 10.5.sp
                    )
                }
            }
        }
    }
}
