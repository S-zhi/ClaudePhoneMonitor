package com.example.claudephonemonitor.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import java.util.Locale
import kotlin.math.max

@Composable
fun MonitorApp(viewModel: MonitorViewModel = viewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    PhoneMonitorTheme {
        MonitorScreen(
            uiState = uiState,
            onToggleControls = viewModel::toggleControls,
            onToggleDemo = viewModel::toggleDemoMode,
            onFinish = viewModel::simulateFinish,
            onError = viewModel::simulateError,
            onHideControls = { viewModel.setControlsVisible(false) },
        )
    }
}

@Composable
private fun MonitorScreen(
    uiState: MonitorUiState,
    onToggleControls: () -> Unit,
    onToggleDemo: () -> Unit,
    onFinish: () -> Unit,
    onError: () -> Unit,
    onHideControls: () -> Unit,
) {
    val stateColor = Color(uiState.petState.color)
    val computerColor = when (uiState.snapshot.computerState) {
        ComputerState.ONLINE -> Color(0xFF8DE6A8)
        ComputerState.STALE -> Color(0xFFF6C76D)
        ComputerState.OFFLINE -> Color(0xFFFF7B85)
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF090D16))
            .pointerInput(Unit) {
                detectTapGestures { onToggleControls() }
            }
            .semantics { contentDescription = "Phone monitor. Tap anywhere to toggle controls." },
    ) {
        PixelPetCanvas(
            state = uiState.petState,
            activity = uiState.activity,
            modifier = Modifier.fillMaxSize(),
        )

        Column(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(start = 22.dp, top = 18.dp),
        ) {
            Text(
                text = "PHONE MONITOR",
                color = Color(0xFFEAF0F5),
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
            Spacer(modifier = Modifier.height(5.dp))
            Text(
                text = "INSTALLATION  ${uiState.snapshot.installationId}",
                color = Color(0xFF65748C),
                fontSize = 10.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
        }

        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(end = 22.dp, top = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(color = computerColor)
            Spacer(modifier = Modifier.width(7.dp))
            Text(
                text = uiState.snapshot.computerState.wireValue.uppercase(Locale.US),
                color = computerColor,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
            Spacer(modifier = Modifier.width(14.dp))
            Text(
                text = "SEQ ${uiState.snapshot.lastSequence.toString().padStart(4, '0')}",
                color = Color(0xFF65748C),
                fontSize = 10.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
        }

        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .padding(top = 190.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StatePill(
                state = uiState.petState,
                activity = uiState.activity,
                color = stateColor,
            )
            Spacer(modifier = Modifier.height(9.dp))
            Text(
                text = uiState.message.uppercase(Locale.US),
                color = Color(0xFF9AA8BC),
                fontSize = 11.sp,
                letterSpacing = 1.sp,
                textAlign = TextAlign.Center,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "CLAUDE ${uiState.snapshot.claudeState.wireValue.uppercase(Locale.US)}  ·  EVENTS ${uiState.eventCount}",
                color = Color(0xFF58667A),
                fontSize = 9.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
        }

        AnimatedVisibility(
            visible = uiState.controlsVisible,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            CompactControls(
                uiState = uiState,
                onToggleDemo = onToggleDemo,
                onFinish = onFinish,
                onError = onError,
                onHideControls = onHideControls,
            )
        }

        AnimatedVisibility(
            visible = !uiState.controlsVisible,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 18.dp),
        ) {
            Text(
                text = "TAP TO SHOW CONTROLS",
                color = Color(0xFF526174),
                fontSize = 9.sp,
                letterSpacing = 1.2.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
        }

        val overlay = uiState.overlayState
        if (overlay != null && uiState.overlayRemainingMs > 0L) {
            TimerOverlay(
                state = overlay,
                remainingMs = uiState.overlayRemainingMs,
                message = uiState.message,
            )
        }
    }
}

@Composable
private fun CompactControls(
    uiState: MonitorUiState,
    onToggleDemo: () -> Unit,
    onFinish: () -> Unit,
    onError: () -> Unit,
    onHideControls: () -> Unit,
) {
    Row(
        modifier = Modifier
            .padding(horizontal = 18.dp, vertical = 16.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xE6172230))
            .border(1.dp, Color(0xFF2B3A4D), RoundedCornerShape(12.dp))
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompactControl(
            label = if (uiState.isDemoMode) "DEMO ON" else "DEMO OFF",
            tint = if (uiState.isDemoMode) Color(0xFFB8F57B) else Color(0xFF8C98A9),
            onClick = onToggleDemo,
        )
        CompactControl(
            label = "FINISH 5S",
            tint = Color(0xFF8FE1FF),
            onClick = onFinish,
        )
        CompactControl(
            label = "ERROR 10S",
            tint = Color(0xFFFF7B85),
            onClick = onError,
        )
        CompactControl(
            label = "HIDE",
            tint = Color(0xFF9AA8BC),
            onClick = onHideControls,
        )
    }
}

@Composable
private fun CompactControl(label: String, tint: Color, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        color = Color(0xFF202D3D),
        contentColor = tint,
        shape = RoundedCornerShape(8.dp),
    ) {
        Text(
            text = label,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
        )
    }
}

@Composable
private fun StatePill(state: PetState, activity: ActivityVariation, color: Color) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(Color(0xD91A2635))
            .border(1.dp, color.copy(alpha = 0.75f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(color = color)
        Spacer(modifier = Modifier.width(7.dp))
        Text(
            text = state.title,
            color = color,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
        )
        Spacer(modifier = Modifier.width(9.dp))
        Text(
            text = activity.label,
            color = Color(0xFF9AA8BC),
            fontSize = 9.sp,
            fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
        )
    }
}

@Composable
private fun TimerOverlay(state: PetState, remainingMs: Long, message: String) {
    val tint = Color(state.color)
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0x66050A11)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(14.dp))
                .background(Color(0xF2141D2A))
                .border(1.dp, tint.copy(alpha = 0.85f), RoundedCornerShape(14.dp))
                .padding(horizontal = 34.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = state.title,
                color = tint,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
                fontFamily = MaterialTheme.typography.headlineMedium.fontFamily,
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = formatTimer(remainingMs),
                color = Color(0xFFEAF0F5),
                fontSize = 46.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = MaterialTheme.typography.headlineMedium.fontFamily,
            )
            Spacer(modifier = Modifier.height(5.dp))
            Text(
                text = message.uppercase(Locale.US),
                color = Color(0xFF9AA8BC),
                fontSize = 10.sp,
                letterSpacing = 0.8.sp,
                fontFamily = MaterialTheme.typography.labelMedium.fontFamily,
            )
        }
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(
        modifier = Modifier
            .size(7.dp)
            .clip(CircleShape)
            .background(color),
    )
}

private fun formatTimer(remainingMs: Long): String =
    String.format(Locale.US, "%.1fs", max(0L, remainingMs) / 1_000f)
