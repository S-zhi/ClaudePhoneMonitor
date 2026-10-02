package com.example.claudephonemonitor.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val MonitorColors = darkColorScheme(
    primary = androidx.compose.ui.graphics.Color(0xFFB8F57B),
    onPrimary = androidx.compose.ui.graphics.Color(0xFF182018),
    secondary = androidx.compose.ui.graphics.Color(0xFF8FE1FF),
    background = androidx.compose.ui.graphics.Color(0xFF090D16),
    surface = androidx.compose.ui.graphics.Color(0xFF111827),
    onSurface = androidx.compose.ui.graphics.Color(0xFFEAF0F5),
)

private val MonitorTypography = Typography(
    headlineMedium = androidx.compose.material3.Typography().headlineMedium.copy(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
    ),
    titleMedium = androidx.compose.material3.Typography().titleMedium.copy(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
    ),
    bodyMedium = androidx.compose.material3.Typography().bodyMedium.copy(
        fontFamily = FontFamily.Monospace,
        letterSpacing = 0.sp,
    ),
    labelMedium = androidx.compose.material3.Typography().labelMedium.copy(
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
