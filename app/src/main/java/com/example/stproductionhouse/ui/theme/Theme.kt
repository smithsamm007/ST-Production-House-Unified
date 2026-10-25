package com.example.stproductionhouse.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = AccentBlue,
    onPrimary = BgDark,
    primaryContainer = PanelDarkVariant,
    onPrimaryContainer = AccentCyan,
    secondary = AccentCyan,
    onSecondary = BgDark,
    background = BgDark,
    onBackground = TextPrimary,
    surface = PanelDark,
    onSurface = TextPrimary,
    surfaceVariant = PanelDarkVariant,
    onSurfaceVariant = TextMuted,
    outline = BorderDark,
    outlineVariant = BorderBright,
    error = StatusBad,
    onError = BgDark
)

@Composable
fun STProductionHouseTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}
