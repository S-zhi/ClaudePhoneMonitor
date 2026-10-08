package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ActivityVariation
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

internal data class ClawdPartMotion(val x: Float = 0f, val y: Float = 0f, val alpha: Float = 1f)
internal data class ClawdMonitorMotion(
    val breathHeight: Int = 0,
    val blinking: Boolean = false,
    val parts: Map<ClawdPart, ClawdPartMotion> = emptyMap(),
)

internal fun sampleClawdMonitorMotion(
    action: ClawdAction,
    elapsedMs: Long,
    activity: ActivityVariation = ActivityVariation.BREATH,
    isSilent: Boolean = false,
): ClawdMonitorMotion {
    if (isSilent || action == ClawdAction.OFFLINE_REST) return ClawdMonitorMotion()
    val elapsed = elapsedMs.coerceAtLeast(0L)
    val wave = ((1.0 - cos(phase(elapsed, action.cycleMs))) * 0.5).toFloat()
    return when (action) {
        ClawdAction.IDLE_REST -> ClawdMonitorMotion(
            breathHeight = (wave * 5f).roundToInt(),
            blinking = elapsed % 6_000L in 5_000L..5_179L,
        )
        ClawdAction.WORKING_TYPING -> {
            val index = (elapsed / action.frameIntervalMs % ClawdTypingHands.sequence.size).toInt()
            val leftRaised = ClawdTypingHands.sequence[index] == 0
            val lift = ClawdTypingHands.CELL_SIZE.toFloat()
            ClawdMonitorMotion(parts = mapOf(
                ClawdPart.LEFT_HAND to ClawdPartMotion(y = if (leftRaised) -lift else 0f),
                ClawdPart.RIGHT_HAND to ClawdPartMotion(y = if (leftRaised) 0f else -lift),
            ))
        }
        ClawdAction.WAITING_POINT -> ClawdMonitorMotion(parts = mapOf(
            ClawdPart.POINT_TIP to ClawdPartMotion(x = -wave * 12f),
        ))
        ClawdAction.FINISH_CHEER -> {
            val lift = if (activity == ActivityVariation.CELEBRATE) 16f else 10f
            ClawdMonitorMotion(parts = mapOf(
                ClawdPart.LEFT_ARM to ClawdPartMotion(y = -wave * lift),
                ClawdPart.RIGHT_ARM to ClawdPartMotion(y = -wave * lift * 0.75f),
            ))
        }
        ClawdAction.ERROR_ALERT -> ClawdMonitorMotion(parts = mapOf(
            ClawdPart.ALERT_MARK to ClawdPartMotion(alpha = if (elapsed % 1_600L < 640L) 1f else 0.4f),
        ))
        else -> ClawdMonitorMotion()
    }
}

internal data class ClawdLayerPlacement(
    val part: ClawdPart,
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int,
    val alpha: Float = 1f,
    val mirrored: Boolean = false,
    val rotationDegrees: Float = 0f,
) {
    val right: Int get() = left + width
    val bottom: Int get() = top + height
}

/** Fit the complete key pose plus local movement, including wide pointed arms, in either aspect ratio. */
internal fun clawdMonitorPlacements(
    width: Int,
    height: Int,
    geometry: ClawdSpriteGeometry,
    motion: ClawdMonitorMotion,
): List<ClawdLayerPlacement> {
    if (width < 8 || height < 8) return emptyList()
    val bounds = geometry.bounds
    val scale = minOf(width * 0.92f / (bounds.width + 48), height * 0.90f / (bounds.height + 48))
    val left = (width - bounds.width * scale) / 2f
    val top = (height - bounds.height * scale) / 2f
    val breathScale = (bounds.height + motion.breathHeight).toFloat() / bounds.height
    return geometry.parts.map { (part, rect) ->
        val local = motion.parts[part] ?: ClawdPartMotion()
        val imageHeight = rect.height * scale * breathScale
        val imageTop = top + bounds.height * scale + (rect.top + local.y - bounds.bottom) * scale * breathScale
        val blink = part == ClawdPart.EYES && motion.blinking
        ClawdLayerPlacement(
            part = part,
            left = (left + (rect.left + local.x - bounds.left) * scale).roundToInt(),
            top = (imageTop + if (blink) imageHeight * 0.45f else 0f).roundToInt(),
            width = (rect.width * scale).roundToInt().coerceAtLeast(1),
            height = (imageHeight * if (blink) 0.12f else 1f).roundToInt().coerceAtLeast(1),
            alpha = local.alpha,
        )
    }
}

internal data class ClawdPlayMotion(
    val travel: Float,
    val movingRight: Boolean,
    val ballSide: Float,
    val hop: Float,
    val ballHop: Float,
    val ballLead: Float,
    val parts: Map<ClawdPart, ClawdPartMotion>,
    val bodyX: Float,
    val ballX: Float,
    /** Continuous orientation marker; visible poses blend while retaining their full silhouettes. */
    val facing: Float,
    val ballRotationDegrees: Float,
    val bodyWidthScale: Float,
    val turnBlend: Float,
)

/** Source-space anchors and phase boundaries shared by the model, layout and regression tests. */
internal object ClawdPlayChoreography {
    const val CYCLE_MS = 8_000L
    const val HALF_CYCLE_MS = 4_000L
    const val APPROACH_END_MS = 800L
    const val WINDUP_END_MS = 1_040L
    const val CONTACT_MS = 1_200L
    const val FOOT_RECOVERY_END_MS = 1_440L
    const val BALL_ROLL_END_MS = 2_240L
    const val CHASE_START_MS = 1_360L
    const val TURN_START_MS = 2_800L
    const val TURN_BLEND_START_MS = 3_280L
    const val TURN_BLEND_END_MS = 3_520L

    const val BODY_CENTER_X = 499.5f
    const val GROUND_Y = 713f
    const val BALL_RADIUS = 76f
    const val CONTACT_SEPARATION = 358.5f
    const val APPROACH_DISTANCE = 130f
    const val BALL_END_X = 480f
    const val MAX_HOP = 280f
    const val CONTACT_EXTENSION = 16f
    const val KICK_LEG_NEUTRAL_RETRACTION = -50f
    const val KICK_LEG_NEUTRAL_DROP = 66f
    const val MAX_BODY_X = BALL_END_X + CONTACT_SEPARATION + APPROACH_DISTANCE
}

/**
 * A complete, local eight-second play loop. Each half approaches a stationary ball, makes foot
 * contact, lets the ball roll ahead, and catches it. Clawd then hops over the stopped ball while
 * turning with a short blend between complete poses, so the character stays recognizable.
 */
internal fun sampleClawdPlayMotion(elapsedMs: Long): ClawdPlayMotion {
    val timing = ClawdPlayChoreography
    val elapsed = elapsedMs.coerceAtLeast(0L) % timing.CYCLE_MS
    val firstHalf = elapsed < timing.HALF_CYCLE_MS
    val section = elapsed % timing.HALF_CYCLE_MS
    val direction = if (firstHalf) 1f else -1f
    val startBallX = -direction * timing.BALL_END_X
    val endBallX = direction * timing.BALL_END_X
    val startBodyX = startBallX - direction * (timing.CONTACT_SEPARATION + timing.APPROACH_DISTANCE)
    val contactBodyX = startBallX - direction * timing.CONTACT_SEPARATION
    val caughtBodyX = endBallX - direction * timing.CONTACT_SEPARATION
    val turnProgress = progress(section, timing.TURN_START_MS, timing.HALF_CYCLE_MS)

    val bodyX = when {
        section < timing.APPROACH_END_MS -> lerp(startBodyX, contactBodyX,
            smooth(progress(section, 0L, timing.APPROACH_END_MS)))
        section < timing.CHASE_START_MS -> contactBodyX
        section < timing.TURN_START_MS -> lerp(contactBodyX, caughtBodyX,
            smooth(progress(section, timing.CHASE_START_MS, timing.TURN_START_MS)))
        else -> endBallX + direction * lerp(-timing.CONTACT_SEPARATION,
            timing.CONTACT_SEPARATION + timing.APPROACH_DISTANCE, smooth(turnProgress))
    }

    val rollProgress = progress(section, timing.CONTACT_MS, timing.BALL_ROLL_END_MS)
    // A kick supplies an impulse at contact; the rolling ball then loses speed to the ground.
    val roll = 1f - (1f - rollProgress) * (1f - rollProgress) * (1f - rollProgress)
    val ballX = lerp(startBallX, endBallX, roll)
    val fullRollDegrees = (timing.BALL_END_X * 2f / timing.BALL_RADIUS * 180f / PI).toFloat()

    val walkProgress = when {
        section < timing.APPROACH_END_MS -> progress(section, 0L, timing.APPROACH_END_MS)
        section in timing.CHASE_START_MS until timing.TURN_START_MS ->
            progress(section, timing.CHASE_START_MS, timing.TURN_START_MS)
        else -> 0f
    }
    val walkEnvelope = minOf(smooth(walkProgress / 0.12f), smooth((1f - walkProgress) / 0.12f))
    val strideCycles = if (section < timing.APPROACH_END_MS) 2f else 4f
    val stridePhase = smooth(walkProgress) * strideCycles * 2f * PI
    val stride = sin(stridePhase).toFloat() * walkEnvelope
    val walkingBob = (1f - cos(stridePhase * 2.0).toFloat()) * walkEnvelope * 2f

    val kickExtension = when {
        section < timing.APPROACH_END_MS -> 0f
        section < timing.WINDUP_END_MS -> -20f * smooth(progress(section,
            timing.APPROACH_END_MS, timing.WINDUP_END_MS))
        section < timing.CONTACT_MS -> lerp(-20f, timing.CONTACT_EXTENSION, smooth(progress(section,
            timing.WINDUP_END_MS, timing.CONTACT_MS)))
        section < timing.FOOT_RECOVERY_END_MS -> timing.CONTACT_EXTENSION * (1f - smooth(progress(section,
            timing.CONTACT_MS, timing.FOOT_RECOVERY_END_MS)))
        else -> 0f
    }
    val kickLift = when {
        section < timing.APPROACH_END_MS -> 0f
        section < timing.WINDUP_END_MS -> 18f * smooth(progress(section,
            timing.APPROACH_END_MS, timing.WINDUP_END_MS))
        section < timing.CONTACT_MS -> 18f * (1f - smooth(progress(section,
            timing.WINDUP_END_MS, timing.CONTACT_MS)))
        else -> 0f
    }
    val kickPoseBlend = when {
        section < timing.APPROACH_END_MS -> 0f
        section < timing.WINDUP_END_MS -> smooth(progress(section, timing.APPROACH_END_MS, timing.WINDUP_END_MS))
        section < timing.CONTACT_MS -> 1f
        section < timing.FOOT_RECOVERY_END_MS -> 1f - smooth(progress(section, timing.CONTACT_MS, timing.FOOT_RECOVERY_END_MS))
        else -> 0f
    }
    val kickLegStrideLift = max(0f, -stride) * 14f
    val kickLegX = lerp(timing.KICK_LEG_NEUTRAL_RETRACTION, kickExtension, kickPoseBlend)
    val kickLegY = lerp(
        timing.KICK_LEG_NEUTRAL_DROP - kickLegStrideLift,
        -kickLegStrideLift - kickLift,
        kickPoseBlend,
    )
    val turnArc = sin(turnProgress * PI).toFloat()
    val turnArcSquared = turnArc * turnArc
    // A broad jump arc clears the whole ball before the full-width body crosses it. Both the
    // takeoff and landing still have zero velocity, unlike clipping a sine into separate hops.
    val turnHop = timing.MAX_HOP * turnArcSquared / (0.25f + 0.75f * turnArcSquared)
    val facing = direction * cos(turnProgress * PI).toFloat()
    return ClawdPlayMotion(
        travel = bodyX / timing.MAX_BODY_X,
        movingRight = facing >= 0f,
        ballSide = direction,
        hop = walkingBob + turnHop,
        ballHop = 0f,
        ballLead = (abs(ballX - bodyX) - timing.CONTACT_SEPARATION).coerceAtLeast(0f),
        parts = mapOf(
            ClawdPart.LEFT_LEG to ClawdPartMotion(y = -max(0f, stride) * 18f),
            ClawdPart.INNER_LEFT_LEG to ClawdPartMotion(y = -max(0f, -stride) * 18f),
            ClawdPart.INNER_RIGHT_LEG to ClawdPartMotion(y = -max(0f, stride) * 18f),
            ClawdPart.KICK_LEG to ClawdPartMotion(x = kickLegX, y = kickLegY),
        ),
        bodyX = bodyX,
        ballX = ballX,
        facing = facing,
        ballRotationDegrees = if (firstHalf) roll * fullRollDegrees else (1f - roll) * fullRollDegrees,
        bodyWidthScale = 1f - 0.18f * turnArcSquared,
        turnBlend = smooth(progress(section, timing.TURN_BLEND_START_MS, timing.TURN_BLEND_END_MS)),
    )
}

internal fun clawdPlayPlacements(
    width: Int,
    height: Int,
    geometry: ClawdSpriteGeometry,
    motion: ClawdPlayMotion,
): List<ClawdLayerPlacement> {
    if (width < 8 || height < 8) return emptyList()
    val bounds = geometry.bounds
    val timing = ClawdPlayChoreography
    val bodyCenterX = timing.BODY_CENTER_X
    val ball = geometry.parts.getValue(ClawdPart.BALL)
    val bodyBounds = geometry.parts.getValue(ClawdPart.BASE)
    val bodyReach = maxOf(bodyCenterX - bodyBounds.left, bodyBounds.right - bodyCenterX)
    val sceneHalfWidth = timing.MAX_BODY_X + bodyReach + timing.CONTACT_EXTENSION
    val sceneHeight = timing.GROUND_Y - bounds.top + timing.MAX_HOP
    val scale = minOf(width * 0.92f / (sceneHalfWidth * 2f), height * 0.82f / sceneHeight)
    val centerX = width / 2f + motion.bodyX * scale
    val ground = height * 0.90f
    // Keep at least one pose opaque throughout the blend. Shared orange pixels retain their
    // source color, and Clawd never narrows into a one-pixel line during the turn.
    val poses = listOf(
        motion.ballSide to (2f * (1f - motion.turnBlend)).coerceAtMost(1f),
        -motion.ballSide to (2f * motion.turnBlend).coerceAtMost(1f),
    ).filter { it.second > 0f }
    val character = geometry.parts.entries.filter { it.key != ClawdPart.BALL }
    val placements = poses.flatMap { (direction, alpha) ->
        val projection = direction * motion.bodyWidthScale
        character.map { (part, rect) ->
            val local = motion.parts[part] ?: ClawdPartMotion()
            // Resize the legs from their attached top edge instead of translating entire crops.
            // The toe reaches the circular ball's contour at y=608..624, not its empty corner.
            val sourceRight = rect.right + if (part == ClawdPart.KICK_LEG) local.x else 0f
            val projectedLeft = (rect.left - bodyCenterX) * projection
            val projectedRight = (sourceRight - bodyCenterX) * projection
            val left = centerX + minOf(projectedLeft, projectedRight) * scale
            val right = centerX + maxOf(projectedLeft, projectedRight) * scale
            val legLift = if (part in playLegParts) local.y else 0f
            val top = ground + (rect.top - timing.GROUND_Y - motion.hop) * scale
            val bottom = ground + (rect.bottom + legLift - timing.GROUND_Y - motion.hop) * scale
            ClawdLayerPlacement(
                part, left.roundToInt(), top.roundToInt(),
                (right.roundToInt() - left.roundToInt()).coerceAtLeast(1),
                (bottom.roundToInt() - top.roundToInt()).coerceAtLeast(1),
                alpha = alpha,
                mirrored = direction < 0f,
            )
        }
    }
    // The ball is a single foreground layer even while the two complete turning poses overlap.
    val ballCenterX = width / 2f + motion.ballX * scale
    val ballCenterY = ground - ball.height * scale / 2f
    return placements + ClawdLayerPlacement(
        ClawdPart.BALL, (ballCenterX - ball.width * scale / 2f).roundToInt(),
        (ballCenterY - ball.height * scale / 2f).roundToInt(),
        (ball.width * scale).roundToInt().coerceAtLeast(1),
        (ball.height * scale).roundToInt().coerceAtLeast(1),
        rotationDegrees = motion.ballRotationDegrees,
    )
}

private val playLegParts = setOf(ClawdPart.LEFT_LEG, ClawdPart.INNER_LEFT_LEG,
    ClawdPart.INNER_RIGHT_LEG, ClawdPart.KICK_LEG)

private fun progress(elapsed: Long, start: Long, end: Long): Float =
    ((elapsed - start).toFloat() / (end - start)).coerceIn(0f, 1f)

private fun smooth(value: Float): Float = value.coerceIn(0f, 1f).let { it * it * (3f - 2f * it) }

private fun lerp(start: Float, end: Float, fraction: Float): Float = start + (end - start) * fraction

private fun phase(elapsed: Long, duration: Long): Double =
    if (duration <= 0L) 0.0 else (elapsed % duration).toDouble() / duration * PI * 2.0
