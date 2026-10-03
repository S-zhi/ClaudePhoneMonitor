package com.example.claudephonemonitor.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState
import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * Procedural Clawd Mascot View.
 * In normal standby/idle, Clawd sits peacefully (NOT walking) and blinks naturally every 5 seconds (90% probability).
 * Walking/running is strictly reserved for active WORKING states.
 */
@Composable
fun ClawdProceduralView(
    state: PetState,
    activity: ActivityVariation,
    isSilent: Boolean = false,
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    // 5-second random micro-action loop in normal idle mode:
    // 90% blink (duration 200ms), 10% cute hand waving (duration 1200ms)
    var isBlinking by remember { mutableStateOf(false) }
    var isMicroAction by remember { mutableStateOf(false) }

    LaunchedEffect(state, isSilent) {
        while (isActive) {
            delay(5_000L) // Trigger once every 5 seconds
            val roll = Random.nextInt(100)
            if (roll < 90) {
                // 90% probability: Natural blink!
                isBlinking = true
                delay(200L)
                isBlinking = false
            } else if (!isSilent && (state == PetState.IDLE || state == PetState.OFFLINE)) {
                // 10% probability: Gentle friendly wave
                isMicroAction = true
                delay(1_200L)
                isMicroAction = false
            }
        }
    }

    // Normal standby is STILL_POSES (sitting still, not walking).
    // Walking/crab-running only happens during active tasks.
    val (poses, sequence, frameDurationMs) = when {
        isSilent || state == PetState.OFFLINE ->
            Triple(ClawdSpriteData.STILL_POSES, ClawdSpriteData.STILL_SEQUENCE, 1000)

        state == PetState.WORKING ->
            Triple(ClawdSpriteData.CRAB_POSES, ClawdSpriteData.CRAB_SEQUENCE, 85)

        state == PetState.WAITING ->
            Triple(ClawdSpriteData.POINT_POSES, ClawdSpriteData.POINT_SEQUENCE, 90)

        state == PetState.FINISH ->
            if (activity == ActivityVariation.CELEBRATE) {
                Triple(ClawdSpriteData.DANCE_POSES, ClawdSpriteData.DANCE_SEQUENCE, 90)
            } else {
                Triple(ClawdSpriteData.JUMP_POSES, ClawdSpriteData.JUMP_SEQUENCE, 90)
            }

        state == PetState.ERROR ->
            Triple(ClawdSpriteData.CRAB_POSES, ClawdSpriteData.CRAB_SEQUENCE, 70)

        isMicroAction -> // 10% occasional cute wave
            Triple(ClawdSpriteData.WAVE_POSES, ClawdSpriteData.WAVE_SEQUENCE, 85)

        else -> // Normal IDLE: Peaceful sitting stance (STILL), not walking!
            Triple(ClawdSpriteData.STILL_POSES, ClawdSpriteData.STILL_SEQUENCE, 1000)
    }

    val totalDurationMs = (sequence.size * frameDurationMs).coerceAtLeast(1000)

    val transition = rememberInfiniteTransition(label = "clawd-procedural-loop")
    val animTimeMs by transition.animateFloat(
        initialValue = 0f,
        targetValue = totalDurationMs.toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(totalDurationMs, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "clawd-time",
    )

    // Ultra subtle breathing loop (no aggressive bobbing during normal idle)
    val breathCycle = if (isSilent) 4_000 else 3_200
    val breathPhase by transition.animateFloat(
        initialValue = 0f,
        targetValue = (PI * 2f).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(breathCycle, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "clawd-breath",
    )

    Canvas(modifier = modifier) {
        val frameIdx = if (sequence.size <= 1) 0 else ((animTimeMs / frameDurationMs).toInt() % sequence.size)
        val poseIdx = sequence[frameIdx].coerceIn(0, poses.lastIndex)
        val matrix = poses[poseIdx]

        val cols = matrix.firstOrNull()?.length ?: ClawdSpriteData.COLS
        val rows = matrix.size

        // Expand Clawd to fill vertical screen space (3x+ scale)
        val maxAvailableHeight = size.height * 0.90f
        val maxAvailableWidth = size.width * 0.95f
        val tile = floor(minOf(maxAvailableWidth / cols, maxAvailableHeight / rows)).coerceAtLeast(8f)

        val spriteW = cols * tile
        val spriteH = rows * tile

        // Subtle vertical breath (tiny 0.04f amplitude so pet stays calmly seated)
        val isSitting = (poses === ClawdSpriteData.STILL_POSES)
        val bobY = if (isSitting) {
            sin(breathPhase.toDouble()).toFloat() * tile * 0.04f
        } else {
            sin(breathPhase.toDouble()).toFloat() * tile * 0.12f
        }

        // Center on available canvas area
        val startX = floor((size.width - spriteW) / 2f)
        val startY = floor((size.height - spriteH) / 2f + bobY)

        // Contact shadow
        val shadowW = spriteW * 0.82f
        val shadowH = tile * 0.8f
        val shadowY = startY + spriteH - shadowH * 0.4f
        drawOval(
            color = Color(0x55000000),
            topLeft = Offset(startX + (spriteW - shadowW) / 2f, shadowY),
            size = Size(shadowW, shadowH),
        )

        // Draw each pixel square
        for (r in 0 until rows) {
            val rowStr = matrix[r]
            for (c in 0 until minOf(cols, rowStr.length)) {
                var pixelChar = rowStr[c]

                // Realistic blinking: when isBlinking is active, convert black eye dots to closed eyelid lines
                if (isBlinking && pixelChar == 'B') {
                    // Top row of eye turns into body color, bottom row turns into eyelid crease shadow
                    pixelChar = if (r == 8) 'O' else 'D'
                }

                val color = resolvePixelColor(pixelChar, isSilent, state)
                if (color != null) {
                    val px = startX + c * tile
                    val py = startY + r * tile
                    drawRect(
                        color = color,
                        topLeft = Offset(px.roundToInt().toFloat(), py.roundToInt().toFloat()),
                        size = Size((tile - 0.75f).coerceAtLeast(1f), (tile - 0.75f).coerceAtLeast(1f)),
                    )
                }
            }
        }
    }
}

private fun resolvePixelColor(char: Char, isSilent: Boolean, state: PetState): Color? = when (char) {
    'O' -> if (isSilent) {
        Color(0xFF9E5640) // Dimmed warm terracotta for silent night
    } else when (state) {
        PetState.OFFLINE -> Color(0xFF6C7685)
        else -> Color(0xFFD97757) // Official Claude Terracotta
    }

    'D' -> if (isSilent) {
        Color(0xFF6E392B)
    } else when (state) {
        PetState.OFFLINE -> Color(0xFF48505C)
        else -> Color(0xFFBF694D) // Official Dark Orange Shadow
    }

    'B' -> Color(0xFF1E1917) // Eyes black

    'W' -> Color(0xFFFFFFFF) // Highlight

    else -> null // Transparent
}
