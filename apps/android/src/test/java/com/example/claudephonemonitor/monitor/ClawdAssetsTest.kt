package com.example.claudephonemonitor.monitor

import com.example.claudephonemonitor.ui.ClawdFrameSet
import com.example.claudephonemonitor.ui.ClawdPersona
import com.example.claudephonemonitor.ui.ClawdPose
import com.example.claudephonemonitor.ui.ClawdSpriteData
import com.example.claudephonemonitor.ui.PixelFont
import com.example.claudephonemonitor.ui.calculateClawdGridLayout
import com.example.claudephonemonitor.ui.resolveClawdAnimation
import com.example.claudephonemonitor.ui.resolveClawdPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ClawdAssetsTest {
    @Test
    fun everySpriteFrameRetainsItsGridAndEverySequenceIndexIsValid() {
        assertEquals(24, ClawdSpriteData.COLS)
        assertEquals(22, ClawdSpriteData.ROWS)

        val spriteSets = listOf(
            ClawdSpriteData.STILL_POSES to ClawdSpriteData.STILL_SEQUENCE,
            ClawdSpriteData.WALK_POSES to ClawdSpriteData.WALK_SEQUENCE,
            ClawdSpriteData.CRAB_POSES to ClawdSpriteData.CRAB_SEQUENCE,
            ClawdSpriteData.WAVE_POSES to ClawdSpriteData.WAVE_SEQUENCE,
            ClawdSpriteData.POINT_POSES to ClawdSpriteData.POINT_SEQUENCE,
            ClawdSpriteData.JUMP_POSES to ClawdSpriteData.JUMP_SEQUENCE,
            ClawdSpriteData.DANCE_POSES to ClawdSpriteData.DANCE_SEQUENCE,
        )

        spriteSets.forEachIndexed { setIndex, (poses, sequence) ->
            assertTrue("Sprite set $setIndex has no frames", poses.isNotEmpty())
            assertTrue("Sprite set $setIndex has no sequence", sequence.isNotEmpty())
            poses.forEachIndexed { poseIndex, frame ->
                assertEquals("Frame $setIndex/$poseIndex row count", ClawdSpriteData.ROWS, frame.size)
                frame.forEachIndexed { rowIndex, row ->
                    assertTrue("Frame $setIndex/$poseIndex/$rowIndex exceeds the 28-cell POINT width", row.length <= 28)
                    assertTrue("Frame $setIndex/$poseIndex/$rowIndex contains an unknown pixel", row.all { it in ".ODBW" })
                }
            }
            sequence.forEachIndexed { sequenceIndex, poseIndex ->
                assertTrue(
                    "Sequence $setIndex index $sequenceIndex points outside its pose list",
                    poseIndex in poses.indices,
                )
            }
        }

        assertEquals(24, ClawdSpriteData.STILL_POSES.single().maxOf(String::length))
        assertEquals(28, ClawdSpriteData.POINT_POSES.maxOf { frame -> frame.maxOf(String::length) })
    }

    @Test
    fun rendererKeepsWholeSpriteInsideWideAndNarrowLandscapeCanvases() {
        val pointFrame = ClawdSpriteData.POINT_POSES[9]
        val landscapeSizes = listOf(
            1_920f to 480f,
            960f to 320f,
            480f to 240f,
            320f to 200f,
            280f to 180f,
        )

        landscapeSizes.forEach { (width, height) ->
            val layout = calculateClawdGridLayout(width, height, pointFrame)
            assertNotNull("No integer pixel scale for ${width}x$height", layout)
            layout!!
            assertEquals(28, layout.columns)
            assertEquals(22, layout.rows)
            assertTrue(layout.pixelSize >= 1)
            assertEquals(layout.columns * layout.pixelSize, layout.width)
            assertEquals(layout.rows * layout.pixelSize, layout.height)
            assertTrue(layout.left >= 0)
            assertTrue(layout.top >= 0)
            assertTrue(layout.left + layout.width <= width.toInt())
            assertTrue(layout.top + layout.height <= height.toInt())
            assertTrue(layout.width <= (width * 0.95f).toInt())
            assertTrue(layout.height <= (height * 0.90f).toInt())
        }

        val stillLayout = calculateClawdGridLayout(960f, 320f, ClawdSpriteData.STILL_POSES.single())
        assertNotNull(stillLayout)
        assertEquals(24, stillLayout!!.columns)
        assertEquals(22, stillLayout.rows)
    }

    @Test
    fun monitorStateSelectsTheExpectedClawdAnimation() {
        val idle = resolveClawdAnimation(PetState.IDLE, ActivityVariation.BREATH)
        assertEquals(ClawdFrameSet.STILL, idle.frameSet)
        assertSame(ClawdSpriteData.STILL_POSES, idle.poses)

        val working = resolveClawdAnimation(PetState.WORKING, ActivityVariation.TOOL)
        assertEquals(ClawdFrameSet.CRAB, working.frameSet)
        assertSame(ClawdSpriteData.CRAB_POSES, working.poses)

        val waiting = resolveClawdAnimation(PetState.WAITING, ActivityVariation.THINK)
        assertEquals(ClawdFrameSet.POINT, waiting.frameSet)
        assertSame(ClawdSpriteData.POINT_POSES, waiting.poses)

        val dancing = resolveClawdAnimation(PetState.FINISH, ActivityVariation.CELEBRATE)
        assertEquals(ClawdFrameSet.DANCE, dancing.frameSet)
        assertSame(ClawdSpriteData.DANCE_POSES, dancing.poses)

        val jumping = resolveClawdAnimation(PetState.FINISH, ActivityVariation.BREATH)
        assertEquals(ClawdFrameSet.JUMP, jumping.frameSet)
        assertSame(ClawdSpriteData.JUMP_POSES, jumping.poses)

        val alert = resolveClawdAnimation(PetState.ERROR, ActivityVariation.ALERT)
        assertEquals(ClawdFrameSet.ALERT, alert.frameSet)
        assertSame("Error keeps the same Clawd body frames as working", working.poses, alert.poses)
        assertSame(working.sequence, alert.sequence)

        val offline = resolveClawdAnimation(PetState.OFFLINE, ActivityVariation.BREATH)
        assertEquals(ClawdFrameSet.STILL, offline.frameSet)
        assertSame(ClawdSpriteData.STILL_POSES, offline.poses)
        assertSame(offline.poses, resolveClawdAnimation(PetState.WORKING, ActivityVariation.TOOL, isSilent = true).poses)

        listOf(working, waiting, dancing, jumping, alert).forEach { animation ->
            assertTrue(
                "${animation.frameSet} frame interval must stay between 85 and 100 ms",
                animation.frameDurationMs in 85..100,
            )
        }
    }

    @Test
    fun bundledPoseResolverUsesTheSameStateSemantics() {
        assertEquals(ClawdPose.STILL, resolveClawdPose(PetState.IDLE, ActivityVariation.BREATH))
        assertEquals(ClawdPose.STILL, resolveClawdPose(PetState.OFFLINE, ActivityVariation.ALERT))
        assertEquals(ClawdPose.CRAB_WALKING, resolveClawdPose(PetState.WORKING, ActivityVariation.TOOL))
        assertEquals(ClawdPose.POINTING, resolveClawdPose(PetState.WAITING, ActivityVariation.THINK))
        assertEquals(ClawdPose.DANCING, resolveClawdPose(PetState.FINISH, ActivityVariation.CELEBRATE))
        assertEquals(ClawdPose.JUMPING_HAPPY, resolveClawdPose(PetState.FINISH, ActivityVariation.BREATH))
        assertEquals(ClawdPose.CRAB_WALKING, resolveClawdPose(PetState.ERROR, ActivityVariation.ALERT))
        assertEquals(
            ClawdPose.MAGNIFIER,
            resolveClawdPose(PetState.WORKING, ActivityVariation.TOOL, ClawdPersona.MAGNIFIER),
        )
        assertTrue(ClawdPose.entries.all { it.assetUri.startsWith("file:///android_asset/clawd/") })
        assertFalse(ClawdPose.entries.any { it.assetUri.startsWith("http") })
    }

    @Test
    fun pixelFontCoversStatusGlyphsWithConsistentFiveBySevenDimensions() {
        val required = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!.:- "
        for (char in required) {
            val glyph = PixelFont.GLYPHS[char]
            assertNotNull("Missing glyph for $char", glyph)
            assertEquals("Glyph rows must be 7 for $char", 7, glyph!!.size)
            for (row in glyph) {
                assertEquals("Glyph cols must be 5 for $char", 5, row.length)
            }
        }
    }
}
