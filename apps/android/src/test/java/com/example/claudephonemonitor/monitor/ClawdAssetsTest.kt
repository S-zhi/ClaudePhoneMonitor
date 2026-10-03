package com.example.claudephonemonitor.monitor

import com.example.claudephonemonitor.ui.ClawdSpriteData
import com.example.claudephonemonitor.ui.PixelFont
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClawdAssetsTest {
    @Test
    fun verifyOfficialSpriteDataDimensionsAndSequences() {
        assertEquals(24, ClawdSpriteData.COLS)
        assertEquals(22, ClawdSpriteData.ROWS)

        // Verify STILL
        assertEquals(1, ClawdSpriteData.STILL_POSES.size)
        assertEquals(22, ClawdSpriteData.STILL_POSES[0].size)
        assertEquals(24, ClawdSpriteData.STILL_POSES[0][0].length)
        assertTrue(ClawdSpriteData.STILL_SEQUENCE.isNotEmpty())

        // Verify WALK
        assertTrue(ClawdSpriteData.WALK_POSES.size >= 5)
        assertTrue(ClawdSpriteData.WALK_SEQUENCE.isNotEmpty())
        ClawdSpriteData.WALK_SEQUENCE.forEach { poseIdx ->
            assertTrue(poseIdx in ClawdSpriteData.WALK_POSES.indices)
        }

        // Verify CRAB
        assertTrue(ClawdSpriteData.CRAB_POSES.size >= 5)
        assertTrue(ClawdSpriteData.CRAB_SEQUENCE.isNotEmpty())
        ClawdSpriteData.CRAB_SEQUENCE.forEach { poseIdx ->
            assertTrue(poseIdx in ClawdSpriteData.CRAB_POSES.indices)
        }

        // Verify WAVE
        assertTrue(ClawdSpriteData.WAVE_POSES.size >= 5)
        assertTrue(ClawdSpriteData.WAVE_SEQUENCE.isNotEmpty())

        // Verify JUMP
        assertTrue(ClawdSpriteData.JUMP_POSES.size >= 5)
        assertTrue(ClawdSpriteData.JUMP_SEQUENCE.isNotEmpty())

        // Verify POINT
        assertTrue(ClawdSpriteData.POINT_POSES.size >= 5)
        assertTrue(ClawdSpriteData.POINT_SEQUENCE.isNotEmpty())
    }

    @Test
    fun verifyPixelFontCoversEssentialStatusGlyphs() {
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
