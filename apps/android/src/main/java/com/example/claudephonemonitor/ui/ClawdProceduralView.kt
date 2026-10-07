package com.example.claudephonemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState
import kotlin.math.floor

/** Renders the accepted local PNG key poses and small, state-specific pixel-layer motions. */
@Composable
fun ClawdProceduralView(
    state: PetState,
    activity: ActivityVariation,
    isSilent: Boolean = false,
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    val action = resolveClawdAction(state, isSilent)
    val images by rememberClawdSprite(action)
    val elapsed = rememberClawdAnimationTime(action, isSilent)
    Canvas(modifier = modifier.semantics {
        clawdKeyPose = action.actionId
        clawdImageReady = images != null
        clawdAnimationTime = elapsed
    }) {
        val sprite = images ?: return@Canvas
        val motion = sampleClawdMonitorMotion(action, elapsed, activity, isSilent)
        drawClawdLayers(sprite, clawdMonitorPlacements(size.width.toInt(), size.height.toInt(), sprite.geometry, motion))
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

internal fun resolvePixelColor(char: Char, isSilent: Boolean, state: PetState): Color? = when (char) {
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
    'H' -> if (isSilent) Color(0xFF8B4A37) else Color(0xFFE18B69)
    'L' -> Color(0xFF686665)
    'K' -> Color(0xFFA6A3A0)
    else -> null
}
