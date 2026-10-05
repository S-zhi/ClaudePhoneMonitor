package com.example.claudephonemonitor.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val MonitorColors = darkColorScheme(
    primary = androidx.compose.ui.graphics.Color(0xFFD97757),
    onPrimary = androidx.compose.ui.graphics.Color(0xFF1B1816),
    secondary = androidx.compose.ui.graphics.Color(0xFFE5A187),
    onSecondary = androidx.compose.ui.graphics.Color(0xFF211915),
    tertiary = androidx.compose.ui.graphics.Color(0xFFE9D7C5),
    background = androidx.compose.ui.graphics.Color(0xFF1B1816),
    surface = androidx.compose.ui.graphics.Color(0xFF28221F),
    surfaceVariant = androidx.compose.ui.graphics.Color(0xFF342D28),
    onSurface = androidx.compose.ui.graphics.Color(0xFFF1E8DE),
    onSurfaceVariant = androidx.compose.ui.graphics.Color(0xFFB2A499),
)

private val DefaultTypography = Typography()
private val MonitorTypography = Typography(
    headlineMedium = DefaultTypography.headlineMedium.copy(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
    ),
    titleMedium = DefaultTypography.titleMedium.copy(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.sp,
    ),
    bodyMedium = DefaultTypography.bodyMedium.copy(
        fontFamily = FontFamily.SansSerif,
        letterSpacing = 0.sp,
    ),
    labelMedium = DefaultTypography.labelMedium.copy(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
    ),
)

@Composable
fun PhoneMonitorTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MonitorColors,
        typography = MonitorTypography,
        content = content,
    )
}
