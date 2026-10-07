package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests use the exact PNGs shipped in the APK, rather than the historical matrix helpers. */
class ClawdKeyPoseAnimationTest {
    @Test
    fun acceptedPngPixelsArePreservedExceptTheRequestedReplacementOfTypingHands() {
        ClawdAction.entries.forEach { action ->
            val fixture = readPose(action)
            assertEquals(1_024, fixture.width)
            assertEquals(1_024, fixture.height)
            assertTrue(fixture.pixels.all { it ushr 24 == 0 || it ushr 24 == 255 })
            val split = fixture.split
            assertEquals(action.subjectBounds, opaqueBounds(fixture.pixels, fixture.width))
            if (action == ClawdAction.WORKING_TYPING) {
                val expectedBase = fixture.pixels.copyOf()
                listOf(ClawdPixelRect(374, 613, 445, 659), ClawdPixelRect(818, 560, 870, 624)).forEach { rect ->
                    for (y in rect.top until rect.bottom) for (x in rect.left until rect.right) {
                        if (expectedBase[y * 1_024 + x] == 0xFFD97757.toInt()) expectedBase[y * 1_024 + x] = 0
                    }
                }
                val baseOnly = ClawdSplitSprite(action, listOf(split.layers.single { it.part == ClawdPart.BASE }))
                assertArrayEquals("Keep PNG body/laptop while removing only its two source-hand blocks", expectedBase, rasterize(baseOnly))
                val actual = rasterize(split)
                for (y in 560 until 624) for (x in 818 until 870) {
                    assertNotEquals("Side hand block remained at $x,$y", 0xFFD97757.toInt(), actual[y * 1_024 + x])
                }
            } else if (action == ClawdAction.USAGE_BALL) {
                val oldBallColors = setOf(0xFF8CAB7B.toInt(), 0xFFA5C595.toInt())
                val expectedCharacter = fixture.pixels.map { if (it in oldBallColors) 0 else it }.toIntArray()
                val characterOnly = ClawdSplitSprite(action, split.layers.filter { it.part != ClawdPart.BALL })
                assertArrayEquals("The new prop must replace only the old obscured ball", expectedCharacter, rasterize(characterOnly))
                assertEquals(ClawdPixelRect(782, 561, 934, 713), split.geometry.parts.getValue(ClawdPart.BALL))
            } else {
                assertArrayEquals("Zero movement must preserve $action source pixels", fixture.pixels, rasterize(split))
            }
            assertTrue("$action must cache cropped layers, not full canvases", split.layers.all {
                it.bounds.width < 1_024 && it.bounds.height < 1_024
            })
            assertTrue("A single decoded action must fit in 5 MiB", split.layers.sumOf { it.pixels.size * 4 } < 5 * 1_024 * 1_024)
        }
    }

    @Test
    fun sixMonitorStatesSelectTheirActualPngAndSilentPairingKeepsItsRestPose() {
        val expected = mapOf(
            PetState.IDLE to ClawdAction.IDLE_REST,
            PetState.WORKING to ClawdAction.WORKING_TYPING,
            PetState.WAITING to ClawdAction.WAITING_POINT,
            PetState.FINISH to ClawdAction.FINISH_CHEER,
            PetState.ERROR to ClawdAction.ERROR_ALERT,
            PetState.OFFLINE to ClawdAction.OFFLINE_REST,
        )
        expected.forEach { (state, action) -> assertEquals(action, resolveClawdAction(state)) }
        assertEquals(ClawdAction.IDLE_REST, resolveClawdAction(PetState.WORKING, isSilent = true))
        assertEquals(ClawdAction.OFFLINE_REST, resolveClawdAction(PetState.OFFLINE, isSilent = true))
        assertEquals(0L, ClawdAction.OFFLINE_REST.frameIntervalMs)
        assertTrue(readPose(ClawdAction.OFFLINE_REST).pixels.any { it == 0xFF6C7685.toInt() })
        assertFalse(readPose(ClawdAction.OFFLINE_REST).pixels.any { it == 0xFFD97757.toInt() })
        assertTrue(sampleClawdMonitorMotion(ClawdAction.IDLE_REST, 5_000L, isSilent = true).parts.isEmpty())
        assertFalse(sampleClawdMonitorMotion(ClawdAction.IDLE_REST, 5_000L, isSilent = true).blinking)
    }

    @Test
    fun actualTypingPixelsMoveOnlyAtHandsAndAllLaptopPixelsStayFixed() {
        val split = readPose(ClawdAction.WORKING_TYPING).split
        val original = rasterize(split)
        val gray = setOf(0xFF686665.toInt(), 0xFFA6A3A0.toInt())
        val expectedLaptop = pixelCoordinates(original) { it in gray }
        assertTrue(expectedLaptop.size > 60_000)
        assertEquals("Foreground laptop must sample the same source canvas as its base",
            split.geometry.parts.getValue(ClawdPart.BASE), split.geometry.parts.getValue(ClawdPart.LAPTOP))
        assertEquals("Right hand must share the base's sampling grid at rest",
            split.geometry.parts.getValue(ClawdPart.BASE), split.geometry.parts.getValue(ClawdPart.RIGHT_HAND))
        assertEquals("Left hand must share the base's sampling grid at rest",
            split.geometry.parts.getValue(ClawdPart.BASE), split.geometry.parts.getValue(ClawdPart.LEFT_HAND))
        val handEnvelopes = listOf(ClawdPixelRect(374, 584, 446, 674), ClawdPixelRect(620, 425, 692, 515))
        val frames = listOf(0L, 320L, 640L, 1_280L).map { time ->
            val motion = sampleClawdMonitorMotion(split.action, time, ActivityVariation.TOOL)
            assertEquals(0, motion.breathHeight)
            assertFalse(motion.blinking)
            assertTrue(motion.parts.keys.all { it in setOf(ClawdPart.LEFT_HAND, ClawdPart.RIGHT_HAND) })
            rasterize(split, motion).also { pixels ->
                assertEquals("The foreground laptop must stay fixed at $time", expectedLaptop, pixelCoordinates(pixels) { it in gray })
                original.indices.filter { original[it] != pixels[it] }.forEach { index ->
                    assertTrue("Non-hand pixel moved at ${index % 1_024},${index / 1_024}", handEnvelopes.any {
                        index % 1_024 in it.left until it.right && index / 1_024 in it.top until it.bottom
                    })
                }
            }
        }
        assertFalse(frames[0].contentEquals(frames[1]))
        assertFalse(frames[1].contentEquals(frames[2]))
        val geometry = split.geometry
        val baseline = clawdMonitorPlacements(960, 320, geometry, sampleClawdMonitorMotion(split.action, 0L))
        listOf(320L, 640L, 1_280L).forEach { time ->
            val placements = clawdMonitorPlacements(960, 320, geometry, sampleClawdMonitorMotion(split.action, time))
            listOf(ClawdPart.BASE, ClawdPart.LAPTOP).forEach { part ->
                assertEquals(baseline.single { it.part == part }, placements.single { it.part == part })
            }
        }
    }

    @Test
    fun typingUsesTheOriginalOutlinedSmallHandsAndTheirAlternatingRhythm() {
        val split = readPose(ClawdAction.WORKING_TYPING).split
        val expectedPattern = listOf(".BB.", "BHHB", "BHHB", ".BB.")
        listOf(ClawdPart.LEFT_HAND to ClawdPixelRect(374, 602, 446, 674),
            ClawdPart.RIGHT_HAND to ClawdPixelRect(620, 443, 692, 515)).forEach { (part, handRect) ->
            val hand = split.layers.single { it.part == part }
            assertEquals(4 * 18 * 18, hand.pixels.count { it == 0xFFE18B69.toInt() })
            assertEquals(8 * 18 * 18, hand.pixels.count { it == 0xFF1E1917.toInt() })
            expectedPattern.forEachIndexed { row, cells -> cells.forEachIndexed { column, cell ->
                val x = handRect.left + column * 18 + 9 - hand.bounds.left
                val y = handRect.top + row * 18 + 9 - hand.bounds.top
                val expected = when (cell) { 'B' -> 0xFF1E1917.toInt(); 'H' -> 0xFFE18B69.toInt(); else -> 0 }
                assertEquals("$part hand cell $column,$row", expected, hand.pixels[y * hand.bounds.width + x])
            } }
        }
        assertEquals(320L, ClawdAction.WORKING_TYPING.frameIntervalMs)
        assertEquals(1_920L, ClawdAction.WORKING_TYPING.cycleMs)
        listOf(true, false, true, true, false, true).forEachIndexed { frame, leftRaised ->
            val motion = sampleClawdMonitorMotion(ClawdAction.WORKING_TYPING, frame * 320L)
            assertEquals(if (leftRaised) -18f else 0f, motion.parts.getValue(ClawdPart.LEFT_HAND).y)
            assertEquals(if (leftRaised) 0f else -18f, motion.parts.getValue(ClawdPart.RIGHT_HAND).y)
        }
        val source = readPose(ClawdAction.WORKING_TYPING).pixels
        val sourceFace = source.copyOfRange(310 * 1_024, 425 * 1_024)
        listOf(0L, 320L, 640L, 1_280L).forEach { time ->
            val actual = rasterize(split, sampleClawdMonitorMotion(split.action, time))
            assertArrayEquals("The small hands must stay below the unchanged closed-eye face", sourceFace,
                actual.copyOfRange(310 * 1_024, 425 * 1_024))
        }
    }

    @Test
    fun nearestScaledTypingFramesKeepEveryGrayPixelFixedOnShortAndNarrowScreens() {
        val split = readPose(ClawdAction.WORKING_TYPING).split
        val gray = setOf(0xFF686665.toInt(), 0xFFA6A3A0.toInt())
        listOf(480 to 280, 280 to 180, 960 to 320, 180 to 480).forEach { (width, height) ->
            val frames = listOf(0L, 320L, 640L, 1_280L).map { time ->
                rasterizeNearest(split, clawdMonitorPlacements(width, height, split.geometry,
                    sampleClawdMonitorMotion(split.action, time)), width, height)
            }
            val expected = pixelCoordinates(frames.first()) { it in gray }
            assertTrue(expected.isNotEmpty())
            frames.forEach { assertEquals("Laptop sampling drift in ${width}x$height", expected, pixelCoordinates(it) { pixel -> pixel in gray }) }
        }
    }

    @Test
    fun errorPulsesOnlyItsSourceRedMarkAndNeverUsesTravelOrGait() {
        val split = readPose(ClawdAction.ERROR_ALERT).split
        val bright = rasterize(split, sampleClawdMonitorMotion(split.action, 0L))
        val dim = rasterize(split, sampleClawdMonitorMotion(split.action, 800L))
        val mark = split.layers.single { it.part == ClawdPart.ALERT_MARK }.bounds
        assertFalse(bright.contentEquals(dim))
        bright.indices.filter { bright[it] != dim[it] }.forEach { index ->
            assertTrue(index % 1_024 in mark.left until mark.right && index / 1_024 in mark.top until mark.bottom)
        }
        val body = split.geometry.parts.getValue(ClawdPart.BASE)
        val first = clawdMonitorPlacements(320, 200, split.geometry, sampleClawdMonitorMotion(split.action, 0L))
        val second = clawdMonitorPlacements(320, 200, split.geometry, sampleClawdMonitorMotion(split.action, 800L))
        assertEquals(first.single { it.part == ClawdPart.BASE }, second.single { it.part == ClawdPart.BASE })
        assertEquals(split.action.subjectBounds, body)
        assertEquals(setOf(ClawdPart.BASE, ClawdPart.ALERT_MARK), split.geometry.parts.keys)
    }

    @Test
    fun theWholePointedFingerRetractsWithoutLeavingItsBottomRowsBehind() {
        val fixture = readPose(ClawdAction.WAITING_POINT)
        val tip = fixture.split.layers.single { it.part == ClawdPart.POINT_TIP }
        val farTip = fixture.pixels.indices.filter { it % 1_024 >= 840 && fixture.pixels[it] ushr 24 != 0 }
        assertTrue(farTip.size > 500)
        assertEquals(454, farTip.maxOf { it / 1_024 } + 1)
        assertTrue(farTip.all { it / 1_024 in tip.bounds.top until tip.bounds.bottom })
        val retracted = rasterize(fixture.split, sampleClawdMonitorMotion(ClawdAction.WAITING_POINT, 1_200L))
        // These last four source rows used to remain as a detached horizontal line.
        for (y in 450 until 454) for (x in 858 until 870) {
            assertEquals("Finger pixel remained at $x,$y", 0, retracted[y * 1_024 + x])
        }
        assertEquals(857, retracted.indices.filter { retracted[it] ushr 24 != 0 }.maxOf { it % 1_024 })
    }

    @Test
    fun idleBreathesAndBlinksWhilePointAndCheerKeepTheirBodyAndFeetAnchored() {
        val idle = readPose(ClawdAction.IDLE_REST).split.geometry
        val rest = clawdMonitorPlacements(640, 360, idle, sampleClawdMonitorMotion(ClawdAction.IDLE_REST, 0L))
        val breath = clawdMonitorPlacements(640, 360, idle, sampleClawdMonitorMotion(ClawdAction.IDLE_REST, 3_000L))
        val blink = clawdMonitorPlacements(640, 360, idle, sampleClawdMonitorMotion(ClawdAction.IDLE_REST, 5_040L))
        assertEquals(rest.single { it.part == ClawdPart.BASE }.bottom, breath.single { it.part == ClawdPart.BASE }.bottom)
        assertTrue(breath.single { it.part == ClawdPart.BASE }.height > rest.single { it.part == ClawdPart.BASE }.height)
        assertTrue(blink.single { it.part == ClawdPart.EYES }.height < rest.single { it.part == ClawdPart.EYES }.height)
        listOf(ClawdAction.WAITING_POINT, ClawdAction.FINISH_CHEER).forEach { action ->
            val split = readPose(action).split
            val firstMotion = sampleClawdMonitorMotion(action, 0L, ActivityVariation.CELEBRATE)
            val secondMotion = sampleClawdMonitorMotion(action, action.cycleMs / 2L, ActivityVariation.CELEBRATE)
            val first = clawdMonitorPlacements(640, 360, split.geometry, firstMotion)
            val second = clawdMonitorPlacements(640, 360, split.geometry, secondMotion)
            assertEquals(first.single { it.part == ClawdPart.BASE }, second.single { it.part == ClawdPart.BASE })
            assertNotEquals(first, second)
            assertFalse(rasterize(split, firstMotion).contentEquals(rasterize(split, secondMotion)))
        }
    }

    @Test
    fun completeAnimatedGroupsFitWideShortNarrowAndPortraitCanvases() {
        val canvases = listOf(1_920 to 480, 960 to 320, 320 to 200, 280 to 180, 640 to 160, 180 to 480, 96 to 48)
        ClawdAction.entries.filter { it != ClawdAction.USAGE_BALL }.forEach { action ->
            val geometry = readPose(action).split.geometry
            canvases.forEach { (width, height) ->
                for (time in 0L..maxOf(6_000L, action.cycleMs) step 80L) {
                    val placements = clawdMonitorPlacements(width, height, geometry, sampleClawdMonitorMotion(action, time, ActivityVariation.CELEBRATE))
                    assertInsideCanvas(action, time, width, height, placements)
                }
            }
        }
        val usage = readPose(ClawdAction.USAGE_BALL).split.geometry
        canvases.forEach { (width, height) ->
            for (time in 0L..8_000L step 80L) {
                assertInsideCanvas(ClawdAction.USAGE_BALL, time, width, height, clawdPlayPlacements(width, height, usage, sampleClawdPlayMotion(time)))
            }
        }
    }

    @Test
    fun usageReadsTheSeparateCompleteBallAssetAndKeepsItsFullRoundContour() {
        val split = readPose(ClawdAction.USAGE_BALL).split
        val ball = split.layers.single { it.part == ClawdPart.BALL }
        val ballColors = ball.pixels.filter { it != 0 }.toSet()
        assertEquals(setOf(0xFF8CAB7B.toInt(), 0xFFA5C595.toInt(), 0xFF526F48.toInt()), ballColors)
        assertFalse(split.layers.single { it.part == ClawdPart.BASE }.pixels.any { it in ballColors })
        assertEquals(ClawdPixelRect(782, 561, 934, 713), ball.bounds)
        assertEquals(152 * 152, ball.pixels.size)
        assertTrue(ball.pixels.count { it ushr 24 == 255 } > 15_000)
        assertEquals(0, ball.pixels.first())
        listOf(76 to 0, 0 to 76, 151 to 76, 76 to 151).forEach { (x, y) ->
            assertEquals("The complete ball's rim must survive at $x,$y", 255, ball.pixels[y * 152 + x] ushr 24)
        }
        assertEquals(713, split.geometry.bounds.bottom)
        assertEquals(934, split.geometry.bounds.right)
        val withoutOldBall = split.layers.filter { it.part != ClawdPart.BALL }.flatMap { it.pixels.asList() }
        assertFalse(withoutOldBall.any { it in ballColors })
    }

    private fun assertInsideCanvas(action: ClawdAction, time: Long, width: Int, height: Int, placements: List<ClawdLayerPlacement>) {
        assertTrue(placements.isNotEmpty())
        placements.forEach {
            assertTrue("$action at $time in ${width}x$height: $it", it.left >= 0 && it.top >= 0 && it.right <= width && it.bottom <= height)
        }
    }
}

private data class PoseFixture(val width: Int, val height: Int, val pixels: IntArray, val split: ClawdSplitSprite)

private fun readPose(action: ClawdAction): PoseFixture {
    val source = readAssetPixels(action.assetPath)
    val originalSplit = splitClawdKeyPose(action, source.width, source.height, source.pixels)
    val split = if (action == ClawdAction.USAGE_BALL) {
        val prop = readAssetPixels(ClawdUsageBallAssetPath)
        replaceClawdUsageBall(originalSplit, prop.width, prop.height, prop.pixels)
    } else originalSplit
    return PoseFixture(source.width, source.height, source.pixels, split)
}

private data class AssetPixels(val width: Int, val height: Int, val pixels: IntArray)

private fun readAssetPixels(assetPath: String): AssetPixels {
    val root = listOf(File("src/main/assets"), File("apps/android/src/main/assets")).first { it.isDirectory }
    // Android's compile bootclasspath omits AWT, while Gradle's JVM has the standard PNG reader.
    // Reflection keeps this test-only helper independent of Android APIs and extra dependencies.
    val image = checkNotNull(Class.forName("javax.imageio.ImageIO").getMethod("read", File::class.java)
        .invoke(null, File(root, assetPath)))
    val width = image.javaClass.getMethod("getWidth").invoke(image) as Int
    val height = image.javaClass.getMethod("getHeight").invoke(image) as Int
    val intType = Integer.TYPE
    val pixels = image.javaClass.getMethod("getRGB", intType, intType, intType, intType, IntArray::class.java, intType, intType)
        .invoke(image, 0, 0, width, height, null, 0, width) as IntArray
    return AssetPixels(width, height, pixels)
}

private fun rasterize(split: ClawdSplitSprite, motion: ClawdMonitorMotion = ClawdMonitorMotion()): IntArray {
    val result = IntArray(1_024 * 1_024)
    split.layers.forEach { layer ->
        val movement = motion.parts[layer.part] ?: ClawdPartMotion()
        layer.pixels.forEachIndexed { index, pixel ->
            if (pixel ushr 24 == 0) return@forEachIndexed
            val x = layer.bounds.left + index % layer.bounds.width + movement.x.toInt()
            val y = layer.bounds.top + index / layer.bounds.width + movement.y.toInt()
            val alpha = ((pixel ushr 24) * movement.alpha).toInt()
            result[y * 1_024 + x] = (pixel and 0x00FFFFFF) or (alpha shl 24)
        }
    }
    return result
}

private fun pixelCoordinates(pixels: IntArray, predicate: (Int) -> Boolean): Set<Int> =
    pixels.indices.filter { predicate(pixels[it]) }.toSet()

private fun rasterizeNearest(split: ClawdSplitSprite, placements: List<ClawdLayerPlacement>, width: Int, height: Int): IntArray {
    val result = IntArray(width * height)
    placements.forEach { placement ->
        val layer = split.layers.single { it.part == placement.part }
        for (y in 0 until placement.height) for (x in 0 until placement.width) {
            val sx = ((x + 0.5f) * layer.bounds.width / placement.width).toInt().coerceAtMost(layer.bounds.width - 1)
            val sy = ((y + 0.5f) * layer.bounds.height / placement.height).toInt().coerceAtMost(layer.bounds.height - 1)
            val pixel = layer.pixels[sy * layer.bounds.width + sx]
            if (pixel ushr 24 != 0) result[(placement.top + y) * width + placement.left + x] = pixel
        }
    }
    return result
}

private fun opaqueBounds(pixels: IntArray, width: Int): ClawdPixelRect {
    val occupied = pixels.indices.filter { pixels[it] ushr 24 != 0 }
    return ClawdPixelRect(occupied.minOf { it % width }, occupied.minOf { it / width }, occupied.maxOf { it % width } + 1, occupied.maxOf { it / width } + 1)
}
