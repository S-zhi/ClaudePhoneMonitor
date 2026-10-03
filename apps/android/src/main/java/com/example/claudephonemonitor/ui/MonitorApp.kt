package com.example.claudephonemonitor.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import java.util.Locale

@Composable
fun MonitorApp(viewModel: MonitorViewModel = viewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    // Ensure the screen stays always on
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

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
    val isSilent = uiState.isSilentMode
    val activeState = uiState.petState
    val isTransitionActive = uiState.transitionRemainingMs > 0L

    // Large Typography artistic gradient colors matching the active state
    val (titleColor1, titleColor2) = if (isSilent) {
        Color(0xFF94A3B8) to Color(0xFF64748B)
    } else {
        when (activeState) {
            PetState.WORKING -> Color(0xFF34D399) to Color(0xFF059669)
            PetState.WAITING -> Color(0xFFFBBF24) to Color(0xFFD97706)
            PetState.FINISH -> Color(0xFF38BDF8) to Color(0xFF0284C7)
            PetState.ERROR -> Color(0xFFF87171) to Color(0xFFDC2626)
            PetState.IDLE -> Color(0xFFFB923C) to Color(0xFFEA580C)
            PetState.OFFLINE -> Color(0xFF94A3B8) to Color(0xFF475569)
        }
    }

    val computerColor = if (isSilent) {
        Color(0xFF5B697D)
    } else {
        when (uiState.snapshot.computerState) {
            ComputerState.ONLINE -> Color(0xFF8DE6A8)
            ComputerState.STALE -> Color(0xFFF6C76D)
            ComputerState.OFFLINE -> Color(0xFFFF7B85)
        }
    }

    val backgroundColor = if (isSilent) Color(0xFF05070B) else Color(0xFF090D15)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(backgroundColor)
            .pointerInput(Unit) {
                detectTapGestures { onToggleControls() }
            }
            .semantics { contentDescription = "Claude phone monitor." },
    ) {
        // Main content layer:
        // When transition is active: Large artistic display words on left, Clawd on right.
        // When transition completes (normal state): Clawd smoothly expands and centers on screen!
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (isTransitionActive) Arrangement.SpaceBetween else Arrangement.Center,
        ) {
            // Left: Extra Large Modern Print Typography (Zero countdown pill, purely huge artistic text)
            // Slower, smoother fade and expand transitions
            AnimatedVisibility(
                visible = isTransitionActive,
                enter = fadeIn(tween(750, easing = FastOutSlowInEasing)) +
                    expandHorizontally(tween(850, easing = FastOutSlowInEasing)),
                exit = fadeOut(tween(1100, easing = FastOutSlowInEasing)) +
                    shrinkHorizontally(tween(1200, easing = FastOutSlowInEasing)),
                modifier = Modifier
                    .weight(1.15f, fill = false)
                    .fillMaxHeight(),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxHeight()
                        .padding(start = 16.dp, end = 20.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    val displayWord = if (isSilent) {
                        "SLEEP"
                    } else when (activeState) {
                        PetState.WORKING -> "WORK"
                        PetState.WAITING -> "WAIT"
                        PetState.FINISH -> "DONE"
                        PetState.ERROR -> "ERR"
                        PetState.IDLE -> "IDLE"
                        PetState.OFFLINE -> "OFF"
                    }

                    // Dynamic extra huge font sizing: 3 letters -> 118sp, 4 letters -> 108sp, 5 letters -> 98sp
                    val titleSize = when {
                        displayWord.length <= 3 -> 118.sp
                        displayWord.length == 4 -> 108.sp
                        else -> 98.sp
                    }
                    val titleLineHeight = when {
                        displayWord.length <= 3 -> 120.sp
                        displayWord.length == 4 -> 110.sp
                        else -> 100.sp
                    }

                    // Extra Large Single-Line Editorial Display Poster Title (No wrap, gigantic visual impact)
                    Text(
                        text = displayWord,
                        fontSize = titleSize,
                        lineHeight = titleLineHeight,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 3.sp,
                        maxLines = 1,
                        softWrap = false,
                        style = androidx.compose.ui.text.TextStyle(
                            brush = Brush.verticalGradient(
                                colors = listOf(titleColor1, titleColor2),
                            ),
                        ),
                        fontFamily = FontFamily.SansSerif,
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    // Elegant secondary subtitle line (Single line, strictly no countdown!)
                    Text(
                        text = if (isSilent) "STANDBY" else uiState.message.uppercase(Locale.US),
                        color = titleColor1.copy(alpha = 0.85f),
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.2.sp,
                        maxLines = 1,
                        softWrap = false,
                        fontFamily = FontFamily.SansSerif,
                    )
                }
            }

            // Right/Center: Screen-filling Giant Procedural Clawd Mascot
            // Naturally centers when left typography gently recedes
            Box(
                modifier = Modifier
                    .weight(if (isTransitionActive) 1.25f else 1.0f)
                    .fillMaxHeight(),
                contentAlignment = Alignment.Center,
            ) {
                ClawdProceduralView(
                    state = activeState,
                    activity = uiState.activity,
                    isSilent = isSilent,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        // Top-Left Minimal Header
        Column(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(start = 22.dp, top = 16.dp),
        ) {
            Text(
                text = "PHONE MONITOR",
                color = Color(0xFFF3F6FA),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                fontFamily = FontFamily.Monospace,
            )
        }

        // Top-Right Status Indicator (Online dot, WS connection & sequence number)
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(end = 22.dp, top = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(color = computerColor)
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "CLAUDE ${uiState.snapshot.computerState.wireValue.uppercase(Locale.US)}",
                color = computerColor,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = "WS ${if (uiState.isConnected) "CONNECTED" else "OFFLINE"}",
                color = if (uiState.isConnected) Color(0xFF8DE6A8) else Color(0xFFFF7B85),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = "SEQ #${uiState.snapshot.lastSequence.toString().padStart(4, '0')}",
                color = Color(0xFF556275),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }

        // Floating Compact Controls (tap screen to toggle, hidden by default for pure clean look)
        AnimatedVisibility(
            visible = uiState.controlsVisible,
            enter = fadeIn(tween(250)),
            exit = fadeOut(tween(250)),
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
            .padding(horizontal = 18.dp, vertical = 14.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xE6172230))
            .border(1.dp, Color(0xFF2B3A4D), RoundedCornerShape(12.dp))
            .padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompactControl(
            label = if (uiState.isDemoMode) "DEMO ON" else "DEMO OFF",
            tint = if (uiState.isDemoMode) Color(0xFFB8F57B) else Color(0xFF8C98A9),
            onClick = onToggleDemo,
        )
        CompactControl(
            label = "FINISH",
            tint = Color(0xFF8FE1FF),
            onClick = onFinish,
        )
        CompactControl(
            label = "ERROR",
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
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color),
    )
}
