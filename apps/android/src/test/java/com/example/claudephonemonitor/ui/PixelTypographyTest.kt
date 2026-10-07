package com.example.claudephonemonitor.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PixelTypographyTest {
    @Test fun naturalSizeIncludesTheLastGlyphAndEveryRow() {
        val geometry = calculatePixelTextGeometry(7, 2f, 1f, 2)
        assertEquals(140f, geometry.width, 0.001f)
        assertEquals(20f, geometry.height, 0.001f)
        assertEquals(1f, geometry.scale, 0f)
    }

    @Test fun narrowParentScalesBothDimensionsWithoutClipping() {
        val original = calculatePixelTextGeometry(7, 3f, 0f, 1)
        val narrow = calculatePixelTextGeometry(7, 3f, 0f, 1, maxWidth = 50f, maxHeight = 30f)
        assertEquals(50f, narrow.width, 0.001f)
        assertTrue(narrow.height <= 30f)
        assertEquals(original.width / original.height, narrow.width / narrow.height, 0.001f)
    }

    @Test fun shortParentPreservesTheEntireWord() {
        val geometry = calculatePixelTextGeometry(7, 3f, 1f, 2, maxWidth = 100f, maxHeight = 10f)
        assertEquals(10f, geometry.height, 0.001f)
        assertTrue(geometry.width <= 100f)
        assertTrue(geometry.scale < 1f)
    }

    @Test fun emptyWordHasNoPaintedSize() {
        val geometry = calculatePixelTextGeometry(0, 3f, 0f, 1)
        assertEquals(0f, geometry.width, 0f)
        assertEquals(0f, geometry.height, 0f)
    }
}
