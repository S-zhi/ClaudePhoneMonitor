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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sin

@Composable
fun PixelPetCanvas(
    state: PetState,
    activity: ActivityVariation,
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    val transition = rememberInfiniteTransition(label = "pixel-pet-loop")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = (PI * 2.0).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(2_200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pixel-pet-phase",
    )
    Canvas(modifier = modifier) {
        drawBackdropGrid()
        drawPixelPet(state = state, activity = activity, phase = phase)
    }
}

private fun DrawScope.drawBackdropGrid() {
    val line = Color(0xFF1A2432)
    val horizon = floor(size.height * 0.76f)
    drawRect(
        color = Color(0xFF0D1420),
        topLeft = Offset(0f, horizon),
        size = Size(size.width, size.height - horizon),
    )
    drawRect(
        color = Color(0xFF263549),
        topLeft = Offset(0f, horizon),
        size = Size(size.width, 2f),
    )
    val columnStep = 44f
    var x = 0f
    while (x <= size.width) {
        drawRect(
            color = line,
            topLeft = Offset(x, horizon + 18f),
            size = Size(2f, 2f),
        )
        x += columnStep
    }
    var y = horizon + 38f
    while (y < size.height) {
        drawRect(
            color = line,
            topLeft = Offset(0f, y),
            size = Size(size.width, 1f),
        )
        y += 28f
    }
}

private fun DrawScope.drawPixelPet(
    state: PetState,
    activity: ActivityVariation,
    phase: Float,
) {
    val rows = SPRITES[state] ?: SPRITES.getValue(PetState.IDLE)
    val maxColumns = rows.maxOf { it.length }
    val tile = floor(minOf(size.width / 26f, size.height / 18f)).coerceAtLeast(10f)
    val spriteWidth = maxColumns * tile
    val spriteHeight = rows.size * tile
    val baseX = floor((size.width - spriteWidth) / 2f)
    val bob = when (activity) {
        ActivityVariation.BREATH -> sin(phase.toDouble()).toFloat() * tile * 0.16f
        ActivityVariation.THINK -> sin(phase.toDouble() * 1.3).toFloat() * tile * 0.28f
        ActivityVariation.TOOL -> abs(sin(phase.toDouble() * 2.0)).toFloat() * tile * 0.34f
        ActivityVariation.WAIT -> sin(phase.toDouble() * 0.55).toFloat() * tile * 0.08f
        ActivityVariation.CELEBRATE -> abs(sin(phase.toDouble() * 2.5)).toFloat() * tile * 0.52f
        ActivityVariation.ALERT -> sin(phase.toDouble() * 4.0).toFloat() * tile * 0.06f
    }
    val baseY = floor(size.height * 0.43f - spriteHeight / 2f + bob)
    val shadowWidth = spriteWidth * when (activity) {
        ActivityVariation.CELEBRATE -> 0.60f
        ActivityVariation.ALERT -> 1.05f
        else -> 0.86f
    }
    drawRect(
        color = Color(0x66000000),
        topLeft = Offset(floor((size.width - shadowWidth) / 2f), floor(size.height * 0.76f - tile * 0.25f)),
        size = Size(shadowWidth, tile * 0.55f),
    )
    withTransform({
        translate(left = (baseX + phaseOffset(activity, phase, tile)).roundToInt().toFloat(), top = baseY.roundToInt().toFloat())
    }) {
        rows.forEachIndexed { rowIndex, row ->
            row.forEachIndexed { columnIndex, pixel ->
                val color = pixelColor(pixel, state)
                if (color != null) {
                    val x = columnIndex * tile
                    val y = rowIndex * tile
                    drawRect(
                        color = color,
                        topLeft = Offset(x.roundToInt().toFloat(), y.roundToInt().toFloat()),
                        size = Size((tile - 1f).coerceAtLeast(1f), (tile - 1f).coerceAtLeast(1f)),
                    )
                }
            }
        }
        drawActivityMarks(activity = activity, phase = phase, tile = tile, width = spriteWidth)
    }
}

private fun phaseOffset(activity: ActivityVariation, phase: Float, tile: Float): Float = when (activity) {
    ActivityVariation.ALERT -> sin(phase.toDouble() * 4.0).toFloat() * tile * 0.12f
    ActivityVariation.TOOL -> sin(phase.toDouble() * 2.0).toFloat() * tile * 0.10f
    else -> 0f
}

private fun DrawScope.drawActivityMarks(
    activity: ActivityVariation,
    phase: Float,
    tile: Float,
    width: Float,
) {
    val glow = Color(0xCCB8F57B)
    when (activity) {
        ActivityVariation.THINK -> {
            val blink = if (sin(phase.toDouble() * 1.5) > 0.1) 1f else 0f
            drawRect(glow.copy(alpha = 0.55f * blink), Offset(width + tile, tile * 1.2f), Size(tile * 0.7f, tile * 0.7f))
            drawRect(glow.copy(alpha = 0.35f * blink), Offset(width + tile * 2f, tile * 0.3f), Size(tile * 0.42f, tile * 0.42f))
        }

        ActivityVariation.TOOL -> {
            val toolY = tile * (6.2f + abs(sin(phase.toDouble() * 2.0)).toFloat())
            drawRect(Color(0xFF8FE1FF), Offset(-tile * 1.6f, toolY), Size(tile * 1.1f, tile * 0.7f))
            drawRect(Color(0xFF49657B), Offset(-tile * 2.4f, toolY + tile * 0.2f), Size(tile * 0.8f, tile * 0.3f))
        }

        ActivityVariation.CELEBRATE -> {
            val sparkle = if (sin(phase.toDouble() * 3.0) > 0) 1f else 0f
            val sparkleColor = Color(0xFFFFD875).copy(alpha = sparkle)
            drawRect(sparkleColor, Offset(-tile * 2f, tile * 0.2f), Size(tile, tile))
            drawRect(sparkleColor, Offset(width + tile, tile * 2.1f), Size(tile, tile))
            drawRect(sparkleColor, Offset(width * 0.45f, -tile * 1.25f), Size(tile, tile))
        }

        ActivityVariation.ALERT -> {
            val alert = if (sin(phase.toDouble() * 4.0) > 0) Color(0xFFFF7B85) else Color(0xFF7A2636)
            drawRect(alert, Offset(-tile * 1.6f, -tile * 0.9f), Size(tile * 0.8f, tile * 0.8f))
            drawRect(alert, Offset(width + tile * 0.8f, -tile * 0.9f), Size(tile * 0.8f, tile * 0.8f))
        }

        ActivityVariation.BREATH,
        ActivityVariation.WAIT -> Unit
    }
}

private fun pixelColor(pixel: Char, state: PetState): Color? {
    val base = when (state) {
        PetState.IDLE -> Color(0xFF65718B)
        PetState.OFFLINE -> Color(0xFF475366)
        PetState.WORKING -> Color(0xFF4A9C78)
        PetState.WAITING -> Color(0xFFB6853F)
        PetState.FINISH -> Color(0xFF4B9AAD)
        PetState.ERROR -> Color(0xFFB54C5D)
    }
    return when (pixel) {
        'B' -> base
        'L' -> base.copy(red = (base.red + 0.20f).coerceAtMost(1f), green = (base.green + 0.20f).coerceAtMost(1f), blue = (base.blue + 0.20f).coerceAtMost(1f))
        'D' -> Color(0xFF263142)
        'E' -> Color(0xFFF5F7E8)
        'A' -> Color(0xFFFFD875)
        'P' -> Color(0xFFFFA8C7)
        'S' -> Color(0xFFB8F57B)
        else -> null
    }
}

private val SPRITES = mapOf(
    PetState.IDLE to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BDDBBBBBDDBB..",
        ".BBEEBBBBEEBBB..",
        ".BBBBBBBBBBBBBB.",
        "..BBBBBAABBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
    PetState.OFFLINE to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BEEBBBBBEEB...",
        ".BBBBBBBBBBBBBB.",
        ".BBBBBBSSBBBBBB.",
        "..BBBBBBBBBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
    PetState.WORKING to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BEEBBBBBEEB...",
        ".BBBBBBBBBBBBBB.",
        ".BBBBBAAABBBBBB.",
        "..BBBBBBBBBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
    PetState.WAITING to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BEEBBBBBEEB...",
        ".BBBBBBBBBBBBBB.",
        ".BBBBBPPPPBBBBB.",
        "..BBBBBBBBBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
    PetState.FINISH to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BEEBBBBBEEB...",
        ".BBBBBBBBBBBBBB.",
        ".BBBBBAAABBBBBB.",
        "..BBBBSSBBBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
    PetState.ERROR to listOf(
        "....BBBBBBBB....",
        "...BLLBBBBLLB...",
        "..BBBBBBBBBBBB..",
        "..BEEBBBBBEEB...",
        ".BBBBBBBBBBBBBB.",
        ".BBBBBPPPPBBBBB.",
        "..BBBBPBBPBBBB..",
        "...BBBBBBBBBB...",
        "....BBBBBBBB....",
        "...BB......BB...",
        "..BB........BB..",
        "................",
    ),
)
