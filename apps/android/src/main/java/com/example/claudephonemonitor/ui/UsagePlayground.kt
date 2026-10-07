package com.example.claudephonemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/** A local PNG play scene with an independent clock; task completion never drives its motion. */
@Composable
internal fun UsagePlayground(modifier: Modifier = Modifier) {
    val action = ClawdAction.USAGE_BALL
    val images by rememberClawdSprite(action)
    val elapsed = rememberClawdAnimationTime(action)
    Canvas(modifier = modifier.semantics {
        contentDescription = "Clawd 走跳踢绿色像素球"
        clawdKeyPose = action.actionId
        clawdImageReady = images != null
        clawdAnimationTime = elapsed
    }) {
        val sprite = images ?: return@Canvas
        drawClawdLayers(sprite, clawdPlayPlacements(
            size.width.toInt(), size.height.toInt(), sprite.geometry, sampleClawdPlayMotion(elapsed),
        ))
    }
}
