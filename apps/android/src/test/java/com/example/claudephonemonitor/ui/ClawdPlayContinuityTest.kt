package com.example.claudephonemonitor.ui

import java.io.File
import kotlin.math.abs
import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Physical timing and silhouette checks for the production Usage animation and its real PNGs. */
class ClawdPlayContinuityTest {
    private val sprite by lazy { usageSprite() }

    @Test fun aStationaryBallIsContactedBeforeItRollsAndClawdCatchesItBeforeTurning() {
        val timing = ClawdPlayChoreography
        listOf(0L, timing.HALF_CYCLE_MS).forEach { start ->
            val direction = if (start == 0L) 1f else -1f
            val initial = sampleClawdPlayMotion(start)
            val ready = sampleClawdPlayMotion(start + timing.APPROACH_END_MS)
            val windup = sampleClawdPlayMotion(start + timing.WINDUP_END_MS)
            val contact = sampleClawdPlayMotion(start + timing.CONTACT_MS)
            val rolled = sampleClawdPlayMotion(start + timing.CONTACT_MS + 80L)
            val caught = sampleClawdPlayMotion(start + timing.TURN_START_MS)

            assertEquals(timing.APPROACH_DISTANCE, direction * (ready.bodyX - initial.bodyX), 0.001f)
            assertEquals(initial.ballX, ready.ballX, 0f)
            assertEquals(initial.ballX, contact.ballX, 0f)
            assertTrue(windup.parts.getValue(ClawdPart.KICK_LEG).x < 0f)
            assertTrue(windup.parts.getValue(ClawdPart.KICK_LEG).y < 0f)
            assertEquals(timing.CONTACT_EXTENSION, contact.parts.getValue(ClawdPart.KICK_LEG).x, 0f)
            assertEquals(0f, contact.parts.getValue(ClawdPart.KICK_LEG).y, 0f)
            assertTrue(direction * (rolled.ballX - contact.ballX) > 0f)
            assertEquals(contact.bodyX, sampleClawdPlayMotion(start + timing.CHASE_START_MS).bodyX, 0f)
            assertEquals(timing.CONTACT_SEPARATION, direction * (caught.ballX - caught.bodyX), 0.001f)
            assertEquals(caught.ballX, sampleClawdPlayMotion(start + 3_600L).ballX, 0f)
            assertEquals(0f, caught.hop, 0.001f)

            // Compare the actual toe and alpha contour, including the ball's pixel steps.
            assertTrue("The prepared foot must have a visible gap", toeBallGap(windup) > 30f)
            val gap = toeBallGap(contact)
            assertTrue("Foot must touch the real ball contour at $start, gap=$gap", gap in -0.5f..1f)

            val before = clawdPlayPlacements(960, 320, sprite.geometry, windup)
                .single { it.part == ClawdPart.KICK_LEG }
            val after = clawdPlayPlacements(960, 320, sprite.geometry, contact)
                .single { it.part == ClawdPart.KICK_LEG }
            assertEquals("The kicking hip must stay vertically attached", before.top, after.top)
            assertEquals("The kicking hip must stay horizontally attached",
                if (direction > 0) before.left else before.right,
                if (direction > 0) after.left else after.right)
        }
    }

    @Test fun kickingLegReturnsToAGroundedNeutralPoseBetweenKicksInBothDirections() {
        val timing = ClawdPlayChoreography
        val width = 960
        val height = 320
        listOf(0L, timing.HALF_CYCLE_MS).forEach { start ->
            fun legAt(offset: Long): Pair<ClawdPlayMotion, ClawdLayerPlacement> {
                val motion = sampleClawdPlayMotion(start + offset)
                val leg = clawdPlayPlacements(width, height, sprite.geometry, motion)
                    .single { it.part == ClawdPart.KICK_LEG }
                return motion to leg
            }

            val neutralStart = legAt(0L)
            val neutralBeforeKick = legAt(timing.APPROACH_END_MS)
            val windup = legAt(timing.WINDUP_END_MS)
            val contact = legAt(timing.CONTACT_MS)
            val recovery = legAt(timing.FOOT_RECOVERY_END_MS)
            val chase = legAt(2_000L)
            val beforeTurn = legAt(timing.TURN_START_MS)

            listOf(neutralStart, neutralBeforeKick, recovery, chase, beforeTurn).forEach { (motion, _) ->
                val pose = motion.parts.getValue(ClawdPart.KICK_LEG)
                assertEquals(timing.KICK_LEG_NEUTRAL_RETRACTION, pose.x, 0.001f)
                assertTrue("Neutral kicking leg must extend down instead of staying raised", pose.y > 50f)
            }
            assertEquals("Neutral foot touches the ground", (height * 0.9f).toInt().toFloat(), neutralStart.second.bottom.toFloat(), 1f)
            assertEquals("The leg is lifted during windup", -18f, windup.first.parts.getValue(ClawdPart.KICK_LEG).y, 0.001f)
            assertEquals("The kick still reaches the ball", timing.CONTACT_EXTENSION,
                contact.first.parts.getValue(ClawdPart.KICK_LEG).x, 0f)
            assertEquals("The foot returns to ground after recovery", (height * 0.9f).toInt().toFloat(), recovery.second.bottom.toFloat(), 1f)
            assertEquals("The neutral pose is restored before the turn", (height * 0.9f).toInt().toFloat(), beforeTurn.second.bottom.toFloat(), 1f)
        }
    }

    @Test fun everyPhaseAndTheLoopJoinKeepPositionAndGaitContinuous() {
        val timing = ClawdPlayChoreography
        assertEquals(sampleClawdPlayMotion(0L), sampleClawdPlayMotion(timing.CYCLE_MS))
        assertEquals(sampleClawdPlayMotion(0L), sampleClawdPlayMotion(-1L))
        val phaseJoins = listOf(0L, timing.APPROACH_END_MS, timing.WINDUP_END_MS,
            timing.CONTACT_MS, timing.CHASE_START_MS, timing.FOOT_RECOVERY_END_MS,
            timing.BALL_ROLL_END_MS, timing.TURN_START_MS, timing.TURN_BLEND_START_MS,
            3_400L, timing.TURN_BLEND_END_MS, timing.HALF_CYCLE_MS)
        phaseJoins.forEach { join ->
            listOf(join, join + timing.HALF_CYCLE_MS).forEach { time ->
                val center = sampleClawdPlayMotion(time)
                val before = sampleClawdPlayMotion(time + timing.CYCLE_MS - 1L)
                val after = sampleClawdPlayMotion(time + 1L)
                assertTrue("Body position jumped at $time", abs(before.bodyX - after.bodyX) < 2.2f)
                assertTrue("Hop position jumped at $time", abs(before.hop - after.hop) < 2.2f)
                assertTrue("Facing jumped at $time", abs(before.facing - after.facing) < 0.006f)
                center.parts.keys.forEach { part ->
                    assertTrue("$part x jumped at $time", abs(before.parts.getValue(part).x - after.parts.getValue(part).x) < 1f)
                    assertTrue("$part y jumped at $time", abs(before.parts.getValue(part).y - after.parts.getValue(part).y) < 1.5f)
                }
                // A real kick changes ball velocity at contact, but it still has a continuous position.
                assertTrue("Ball position jumped at $time", abs(before.ballX - after.ballX) < 6f)
            }
        }

        var previous = sampleClawdPlayMotion(0L)
        for (time in 1L..timing.CYCLE_MS) {
            val current = sampleClawdPlayMotion(time)
            assertTrue("Body teleport at $time", abs(current.bodyX - previous.bodyX) < 1.1f)
            assertTrue("Ball teleport at $time", abs(current.ballX - previous.ballX) < 2.8f)
            assertTrue("Hop discontinuity at $time", abs(current.hop - previous.hop) < 1.1f)
            assertTrue("Turn discontinuity at $time", abs(current.facing - previous.facing) < 0.003f)
            previous = current
        }
    }

    @Test fun theWholeTurningSilhouetteClearsTheBallAndBlendsWithoutDisappearing() {
        val timing = ClawdPlayChoreography
        val ball = sprite.layers.single { it.part == ClawdPart.BALL }
        val radius = ball.pixels.indices.filter { ball.pixels[it] ushr 24 != 0 }.maxOf { index ->
            hypot(index % ball.bounds.width + 0.5f - ball.bounds.width / 2f,
                index / ball.bounds.width + 0.5f - ball.bounds.height / 2f)
        }
        // Sparse silhouette points are enough here; all edge pixels are included separately below.
        val character = sprite.layers.filter { it.part != ClawdPart.BALL }.flatMap { layer ->
            layer.pixels.indices.filter { index ->
                if (layer.pixels[index] ushr 24 == 0) false
                else index % 7 == 0 || index % layer.bounds.width == layer.bounds.width - 1 ||
                    index / layer.bounds.width == layer.bounds.height - 1
            }.map { index ->
                Triple(layer.part, layer.bounds.left + index % layer.bounds.width + 0.5f,
                    layer.bounds.top + index / layer.bounds.width + 0.5f)
            }
        }
        listOf(0L, timing.HALF_CYCLE_MS).forEach { start ->
            for (time in timing.TURN_START_MS..timing.HALF_CYCLE_MS step 20L) {
                val motion = sampleClawdPlayMotion(start + time)
                val ballCenterY = timing.GROUND_Y - ball.bounds.height / 2f
                val visibleDirections = buildList {
                    if (motion.turnBlend < 1f) add(motion.ballSide)
                    if (motion.turnBlend > 0f) add(-motion.ballSide)
                }
                visibleDirections.forEach { direction ->
                    character.forEach { (_, sourceX, sourceY) ->
                        val x = motion.bodyX + (sourceX - timing.BODY_CENTER_X) * direction * motion.bodyWidthScale
                        val y = sourceY - motion.hop
                        assertTrue("Turning character passed through the ball at ${start + time}",
                            hypot(x - motion.ballX, y - ballCenterY) > radius)
                    }
                }
                val layers = clawdPlayPlacements(960, 320, sprite.geometry, motion)
                assertEquals("The ball must never be duplicated during a turn", 1,
                    layers.count { it.part == ClawdPart.BALL })
                assertEquals("At least one complete pose must retain its source color", 1f,
                    layers.filter { it.part == ClawdPart.BASE }.maxOf { it.alpha }, 0f)
                assertTrue("Character must keep a readable silhouette", motion.bodyWidthScale >= 0.8199f)
            }
            val midpoint = start + (timing.TURN_START_MS + timing.HALF_CYCLE_MS) / 2L
            val before = clawdPlayPlacements(960, 320, sprite.geometry, sampleClawdPlayMotion(midpoint - 1L))
                .filter { it.part == ClawdPart.BASE }
            val after = clawdPlayPlacements(960, 320, sprite.geometry, sampleClawdPlayMotion(midpoint + 1L))
                .filter { it.part == ClawdPart.BASE }
            assertEquals(2, before.size)
            assertEquals(2, after.size)
            assertFalse(before[0].mirrored == before[1].mirrored)
            assertTrue("Turn must blend complete poses", before.all { it.width > 100 })
            assertTrue("The outgoing pose must fade continuously", after[0].alpha < before[0].alpha)
            assertTrue("The incoming pose must become fully visible", before[1].alpha < after[1].alpha)
            before.zip(after).forEach { (a, b) ->
                assertTrue("Blended poses must stay aligned", abs(a.left - b.left) <= 1 && abs(a.top - b.top) <= 1)
            }
            assertEquals(timing.MAX_HOP, sampleClawdPlayMotion(midpoint).hop, 0.001f)
        }
    }

    @Test fun everyFrameFitsShortNarrowAndWideCanvasesAndTheBallStaysOnOneGroundLine() {
        val geometry = sprite.geometry
        listOf(1_920 to 480, 960 to 320, 640 to 160, 320 to 200, 180 to 480, 96 to 48).forEach { (width, height) ->
            val ballGround = clawdPlayPlacements(width, height, geometry, sampleClawdPlayMotion(0L))
                .single { it.part == ClawdPart.BALL }.bottom
            for (time in 0L..ClawdPlayChoreography.CYCLE_MS step 16L) {
                val placements = clawdPlayPlacements(width, height, geometry, sampleClawdPlayMotion(time))
                assertEquals(ClawdPart.BALL, placements.last().part)
                placements.forEach { layer ->
                    assertTrue("Clipped $layer at $time in ${width}x$height",
                        layer.left >= 0 && layer.top >= 0 && layer.right <= width && layer.bottom <= height)
                }
                val ball = placements.last()
                assertEquals("Ball must stay round", ball.width, ball.height)
                assertEquals("The rolling ball must stay grounded", ballGround, ball.bottom)
            }
        }
    }

    private fun toeBallGap(motion: ClawdPlayMotion): Float {
        val kick = sprite.layers.single { it.part == ClawdPart.KICK_LEG }
        val ball = sprite.layers.single { it.part == ClawdPart.BALL }
        val foot = motion.parts.getValue(ClawdPart.KICK_LEG)
        val footWidth = kick.bounds.width + foot.x
        val footHeight = kick.bounds.height + foot.y
        val ballLeft = ClawdPlayChoreography.CONTACT_SEPARATION - ball.bounds.width / 2f
        var smallestGap = Float.MAX_VALUE
        for (row in 0 until kick.bounds.height) {
            val lastFoot = (kick.bounds.width - 1 downTo 0).firstOrNull {
                kick.pixels[row * kick.bounds.width + it] ushr 24 != 0
            } ?: continue
            val footX = kick.bounds.left - ClawdPlayChoreography.BODY_CENTER_X +
                (lastFoot + 0.5f) * footWidth / kick.bounds.width
            val footY = kick.bounds.top + (row + 0.5f) * footHeight / kick.bounds.height
            val ballRow = (footY - ball.bounds.top).toInt()
            if (ballRow !in 0 until ball.bounds.height) continue
            val firstBall = (0 until ball.bounds.width).firstOrNull {
                ball.pixels[ballRow * ball.bounds.width + it] ushr 24 != 0
            } ?: continue
            // Work in the canonical right-facing frame; both halves use the same cropped pixels.
            smallestGap = minOf(smallestGap, ballLeft + firstBall - footX)
        }
        return smallestGap
    }
}

private fun usageSprite(): ClawdSplitSprite {
    val root = listOf(File("src/main/assets"), File("apps/android/src/main/assets")).first { it.isDirectory }
    val source = readUsagePng(File(root, ClawdAction.USAGE_BALL.assetPath))
    val prop = readUsagePng(File(root, ClawdUsageBallAssetPath))
    val split = splitClawdKeyPose(ClawdAction.USAGE_BALL, source.first, source.second, source.third)
    return replaceClawdUsageBall(split, prop.first, prop.second, prop.third)
}

private fun readUsagePng(file: File): Triple<Int, Int, IntArray> {
    val image = checkNotNull(Class.forName("javax.imageio.ImageIO").getMethod("read", File::class.java).invoke(null, file))
    val width = image.javaClass.getMethod("getWidth").invoke(image) as Int
    val height = image.javaClass.getMethod("getHeight").invoke(image) as Int
    val intType = Integer.TYPE
    val pixels = image.javaClass.getMethod("getRGB", intType, intType, intType, intType, IntArray::class.java, intType, intType)
        .invoke(image, 0, 0, width, height, null, 0, width) as IntArray
    return Triple(width, height, pixels)
}
