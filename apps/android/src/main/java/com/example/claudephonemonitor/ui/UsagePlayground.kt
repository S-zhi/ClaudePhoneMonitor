package com.example.claudephonemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/** A local PNG play scene with an independent clock; task completion never drives its motion. */
@Composable
internal fun UsagePlayground(modifier: Modifier = Modifier) {
    val action = ClawdAction.USAGE_BALL
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        val images by rememberClawdSprite(action)
        val elapsed = rememberClawdAnimationTimeState(action)
        val sprite = images
        val viewportHeight = maxHeight.coerceAtMost(160.dp)
        Canvas(modifier = Modifier.fillMaxWidth().height(viewportHeight).graphicsLayer().semantics {
            contentDescription = "Clawd 走跳踢绿色像素球"
            clawdKeyPose = action.actionId
            clawdImageReady = sprite != null
        }) {
            val readySprite = sprite ?: return@Canvas
            // Snapshot state is observed by the draw phase only, avoiding a layout/semantics
            // recomposition for every animation tick.
            val elapsedMs = elapsed.value
            drawClawdLayers(readySprite, clawdPlayPlacements(
                size.width.toInt(), size.height.toInt(), readySprite.geometry, sampleClawdPlayMotion(elapsedMs),
            ))
        }
    }
}
