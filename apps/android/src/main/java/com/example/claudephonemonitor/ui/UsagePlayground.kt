package com.example.claudephonemonitor.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.example.claudephonemonitor.monitor.PetState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/** A local, independent play scene; task completion never drives its animation. */
@Composable
internal fun UsagePlayground(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "usage-playground")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(8_000, easing = LinearEasing), RepeatMode.Restart),
        label = "clawd-chases-ball",
    )
    Box(
        modifier = modifier.semantics { contentDescription = "Clawd 走跳踢绿色像素球" },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val ground = floor(size.height * 0.88f)

            val phase = progress * PI * 2.0
            val movingRight = cos(phase) >= 0.0
            val sequence = ClawdSpriteData.CRAB_SEQUENCE
            val frame = sequence[(progress * 88).toInt() % sequence.size]
            val matrix = ClawdSpriteData.CRAB_POSES[frame]
            val layout = calculateClawdGridLayout(size.width * 0.24f, size.height * 0.70f, matrix) ?: return@Canvas
            val tile = layout.pixelSize.toFloat()
            val spriteWidth = layout.width.toFloat()
            val spriteHeight = layout.height.toFloat()
            val center = size.width * (0.5f + 0.28f * sin(phase).toFloat())
            val spriteX = floor((center - spriteWidth / 2f).coerceIn(0f, (size.width - spriteWidth).coerceAtLeast(0f)))
            val hop = abs(sin(phase * 4.0)).toFloat() * tile * 1.5f
            val spriteY = floor(ground - spriteHeight - hop)
            drawOval(Color(0x55000000), Offset(spriteX, ground - tile), Size(spriteWidth, tile * 1.5f))
            matrix.forEachIndexed { row, pixels ->
                pixels.forEachIndexed pixel@{ column, pixel ->
                    val color = resolvePixelColor(pixel, false, PetState.IDLE) ?: return@pixel

                    val x = if (movingRight) column else layout.columns - column - 1
                    drawRect(color, Offset(spriteX + x * tile, spriteY + row * tile), Size(tile, tile))
                }
            }
            val ballSize = (tile * 3f).coerceAtLeast(6f)
            val ballX = (center + (if (movingRight) 1f else -1f) * (spriteWidth / 2f + ballSize * 2f))
                .coerceIn(ballSize, (size.width - ballSize).coerceAtLeast(ballSize))
            val ballY = ground - ballSize - abs(sin(phase * 4.0 + 0.8)).toFloat() * ballSize * 1.2f
            drawRect(Color(0xFFA5C595), Offset(floor(ballX), floor(ballY)), Size(ballSize, ballSize))
            drawRect(Color(0xFF8CAB7B), Offset(floor(ballX + ballSize / 3f), floor(ballY + ballSize / 3f)), Size(ballSize / 3f, ballSize / 3f))
        }
    }
}
