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
import androidx.compose.runtime.mutableIntStateOf
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * Procedural Clawd mascot renderer. Idle uses the still frame with an occasional blink; active
 * monitor states select local pixel-frame sequences and never load image or network assets.
 */
@Composable
fun ClawdProceduralView(
    state: PetState,
    activity: ActivityVariation,
    isSilent: Boolean = false,
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    var isBlinking by remember { mutableStateOf(false) }
    LaunchedEffect(state) {
        isBlinking = false
        if (state != PetState.IDLE) return@LaunchedEffect

        while (isActive) {
            delay(5_000L)
            isBlinking = true
            delay(180L)
            isBlinking = false
        }
    }

    val animation = resolveClawdAnimation(state, activity, isSilent)
    var frameIndex by remember(state, activity, isSilent) { mutableIntStateOf(0) }
    LaunchedEffect(state, activity, isSilent) {
        frameIndex = 0
        if (animation.sequence.size <= 1) return@LaunchedEffect

        while (isActive) {
            delay(animation.frameDurationMs.toLong())
            frameIndex = (frameIndex + 1) % animation.sequence.size
        }
    }

    val transition = rememberInfiniteTransition(label = "clawd-breath-loop")
    val breathCycleMs = if (isSilent) 4_000 else 3_200
    val breathPhase by transition.animateFloat(
        initialValue = 0f,
        targetValue = (PI * 2f).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(breathCycleMs, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "clawd-breath-phase",
    )

    Canvas(modifier = modifier) {
        val frameNumber = frameIndex % animation.sequence.size
        val poseIndex = animation.sequence[frameNumber].coerceIn(animation.poses.indices)
        val matrix = animation.poses[poseIndex]
        val layout = calculateClawdGridLayout(size.width, size.height, matrix)
            ?: return@Canvas

        val tile = layout.pixelSize.toFloat()
        val spriteWidth = layout.width.toFloat()
        val spriteHeight = layout.height.toFloat()
        val isStill = animation.frameSet == ClawdFrameSet.STILL
        val bobY = sin(breathPhase.toDouble()).toFloat() * tile * if (isStill) 0.04f else 0.12f
        val startX = layout.left.toFloat()
        // Round the gentle bob to a whole physical pixel so the sprite stays crisp.
        val startY = (layout.top + bobY).roundToInt().toFloat()

        val shadowWidth = spriteWidth * 0.82f
        val shadowHeight = tile * 0.8f
        drawOval(
            color = Color(0x55000000),
            topLeft = Offset(startX + (spriteWidth - shadowWidth) / 2f, startY + spriteHeight - shadowHeight * 0.4f),
            size = Size(shadowWidth, shadowHeight),
        )

        for (row in matrix.indices) {
            val rowString = matrix[row]
            for (column in rowString.indices) {
                var pixel = rowString[column]
                if (isBlinking && pixel == 'B') {
                    pixel = if (row == 8) 'O' else 'D'
                }

                val color = resolvePixelColor(pixel, isSilent, state) ?: continue
                drawRect(
                    color = color,
                    topLeft = Offset(startX + column * tile, startY + row * tile),
                    // Full integer-sized squares keep adjacent pixels seamless.
                    size = Size(tile, tile),
                )
            }
        }

        if (animation.frameSet == ClawdFrameSet.ALERT) {
            val alertColor = if (sin(breathPhase.toDouble() * 4.0) >= 0.0) {
                Color(0xFFFF7B85)
            } else {
                Color(0xFF7A2636)
            }
            val markY = startY + tile * 2f
            val markSize = Size(tile, tile)
            drawRect(alertColor, Offset(startX + tile, markY), markSize)
            drawRect(alertColor, Offset(startX + (layout.columns - 2) * tile, markY), markSize)
        }
    }
}

/**
 * Computes a centered integer-pixel grid that contains every matrix row. POINT frames extend to 28
 * columns; other base frames retain the 24 x 22 Clawd grid. Returns null only when the canvas is
 * physically too small to display a single whole pixel without clipping.
 */
internal data class ClawdGridLayout(
    val columns: Int,
    val rows: Int,
    val pixelSize: Int,
    val left: Int,
    val top: Int,
) {
    val width: Int get() = columns * pixelSize
    val height: Int get() = rows * pixelSize
}

internal fun calculateClawdGridLayout(
    canvasWidth: Float,
    canvasHeight: Float,
    matrix: List<String>,
): ClawdGridLayout? {
    if (canvasWidth <= 0f || canvasHeight <= 0f || matrix.isEmpty()) return null

    val columns = maxOf(ClawdSpriteData.COLS, matrix.maxOfOrNull(String::length) ?: 0)
    val rows = maxOf(ClawdSpriteData.ROWS, matrix.size)
    val integerCanvasWidth = floor(canvasWidth).toInt().coerceAtLeast(0)
    val integerCanvasHeight = floor(canvasHeight).toInt().coerceAtLeast(0)
    val availableWidth = floor(integerCanvasWidth * 0.95f).toInt()
    val availableHeight = floor(integerCanvasHeight * 0.90f).toInt()
    val pixelSize = floor(
        minOf(availableWidth.toFloat() / columns, availableHeight.toFloat() / rows),
    ).toInt()
    if (pixelSize < 1) return null

    val width = columns * pixelSize
    val height = rows * pixelSize
    return ClawdGridLayout(
        columns = columns,
        rows = rows,
        pixelSize = pixelSize,
        left = (integerCanvasWidth - width) / 2,
        top = (integerCanvasHeight - height) / 2,
    )
}

private fun resolvePixelColor(char: Char, isSilent: Boolean, state: PetState): Color? = when (char) {
    'O' -> when {
        state == PetState.OFFLINE -> Color(0xFF6C7685)
        isSilent -> Color(0xFF9E5640)
        state == PetState.ERROR -> Color(0xFFD96C70)
        else -> Color(0xFFD97757)
    }

    'D' -> when {
        state == PetState.OFFLINE -> Color(0xFF48505C)
        isSilent -> Color(0xFF6E392B)
        state == PetState.ERROR -> Color(0xFF9B414C)
        else -> Color(0xFFBF694D)
    }

    'B' -> Color(0xFF1E1917)
    'W' -> Color(0xFFFFFFFF)
    else -> null
}
