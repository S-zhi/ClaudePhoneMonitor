package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.PetState

/** Coordinates in the accepted, unmodified 1024 × 1024 transparent key-pose PNGs. */
internal data class ClawdPixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}

internal enum class ClawdAction(
    val actionId: String,
    val subjectBounds: ClawdPixelRect,
    val frameIntervalMs: Long,
    val cycleMs: Long,
) {
    IDLE_REST("idle-rest", ClawdPixelRect(153, 275, 870, 748), 100L, 6_000L),
    WORKING_TYPING("working-typing", ClawdPixelRect(153, 310, 870, 714), 320L, 1_920L),
    WAITING_POINT("waiting-point", ClawdPixelRect(153, 308, 870, 716), 160L, 2_400L),
    FINISH_CHEER("finish-cheer", ClawdPixelRect(153, 289, 870, 734), 100L, 1_600L),
    ERROR_ALERT("error-alert", ClawdPixelRect(153, 273, 870, 751), 160L, 1_600L),
    OFFLINE_REST("offline-rest", ClawdPixelRect(153, 278, 870, 745), 0L, 0L),
    USAGE_BALL("usage-ball", ClawdPixelRect(153, 250, 870, 773), 32L, 8_000L);

    val assetPath: String get() = "clawd/actions/$actionId-clean.png"
}

internal fun resolveClawdAction(state: PetState, isSilent: Boolean = false): ClawdAction = when {
    state == PetState.OFFLINE -> ClawdAction.OFFLINE_REST
    isSilent -> ClawdAction.IDLE_REST
    state == PetState.WORKING -> ClawdAction.WORKING_TYPING
    state == PetState.WAITING -> ClawdAction.WAITING_POINT
    state == PetState.FINISH -> ClawdAction.FINISH_CHEER
    state == PetState.ERROR -> ClawdAction.ERROR_ALERT
    else -> ClawdAction.IDLE_REST
}

internal enum class ClawdPart {
    BASE, EYES, LEFT_HAND, RIGHT_HAND, LAPTOP, POINT_TIP, LEFT_ARM, RIGHT_ARM, ALERT_MARK,
    LEFT_LEG, INNER_LEFT_LEG, INNER_RIGHT_LEG, KICK_LEG, BALL,
}

internal data class ClawdPixelLayer(val part: ClawdPart, val bounds: ClawdPixelRect, val pixels: IntArray)
internal data class ClawdSpriteGeometry(val bounds: ClawdPixelRect, val parts: Map<ClawdPart, ClawdPixelRect>)
internal data class ClawdSplitSprite(val action: ClawdAction, val layers: List<ClawdPixelLayer>) {
    val geometry: ClawdSpriteGeometry
        get() = ClawdSpriteGeometry(
            ClawdPixelRect(layers.minOf { it.bounds.left }, layers.minOf { it.bounds.top },
                layers.maxOf { it.bounds.right }, layers.maxOf { it.bounds.bottom }),
            layers.associate { it.part to it.bounds },
        )
}

private val BodyPixel = 0xFFD97757.toInt()
private val EyePixel = 0xFF1E1917.toInt()
private val AlertPixel = 0xFFC5524F.toInt()
private val BallPixels = setOf(0xFF8CAB7B.toInt(), 0xFFA5C595.toInt())
private val LaptopPixels = setOf(0xFF686665.toInt(), 0xFFA6A3A0.toInt())
private val PalmPixel = 0xFFE18B69.toInt()

/** The user's original 4 × 4 outlined hand style, positioned in the current PNG's coordinate grid. */
internal object ClawdTypingHands {
    const val CELL_SIZE = 18
    val pattern = listOf(".BB.", "BHHB", "BHHB", ".BB.")
    val sequence = intArrayOf(0, 1, 0, 0, 1, 0)
    val leftBounds = ClawdPixelRect(374, 602, 446, 674)
    val rightBounds = ClawdPixelRect(620, 443, 692, 515)
}

internal const val ClawdUsageBallAssetPath = "clawd/props/usage-soccer-ball.png"
internal val ClawdUsageBallBounds = ClawdPixelRect(782, 561, 934, 713)

/** Shared by Android and JVM previews: the complete prop replaces the source pose's obscured ball. */
internal fun replaceClawdUsageBall(sprite: ClawdSplitSprite, width: Int, height: Int, propPixels: IntArray): ClawdSplitSprite {
    require(sprite.action == ClawdAction.USAGE_BALL && width > 0 && height > 0 && propPixels.size == width * height)
    val crop = trimLayer(ClawdPart.BALL, ClawdPixelRect(0, 0, width, height), propPixels)
    val bounds = ClawdUsageBallBounds
    val resized = IntArray(bounds.width * bounds.height) { index ->
        val x = index % bounds.width
        val y = index / bounds.width
        val sourceX = ((x + 0.5f) * crop.bounds.width / bounds.width).toInt().coerceAtMost(crop.bounds.width - 1)
        val sourceY = ((y + 0.5f) * crop.bounds.height / bounds.height).toInt().coerceAtMost(crop.bounds.height - 1)
        crop.pixels[sourceY * crop.bounds.width + sourceX]
    }
    val character = sprite.layers.filter { it.part != ClawdPart.BALL }.map { layer ->
        if (layer.part == ClawdPart.BASE) trimLayer(layer.part, layer.bounds, layer.pixels) else layer
    }
    return ClawdSplitSprite(sprite.action, character + ClawdPixelLayer(ClawdPart.BALL, bounds, resized))
}

private data class LayerMask(
    val part: ClawdPart,
    val bounds: ClawdPixelRect,
    val colors: Set<Int>,
    val replacement: Int = 0,
    val keepSourceInBase: Boolean = false,
    val showOverlay: Boolean = true,
    val trim: Boolean = true,
    val canvasBounds: ClawdPixelRect? = null,
    // Retain a small wrist attachment under moving raised arms / the bent kicking leg.
    val keepBaseAbove: Int = Int.MIN_VALUE,
    val keepBaseBelow: Int = Int.MAX_VALUE,
)

/** Keeps the accepted PNG pose, with the user's original code-authored small hands for typing. */
internal fun splitClawdKeyPose(action: ClawdAction, width: Int, height: Int, source: IntArray): ClawdSplitSprite {
    require(width == 1_024 && height == 1_024 && source.size == width * height)
    val bounds = action.subjectBounds
    val base = IntArray(bounds.width * bounds.height) { index ->
        source[(bounds.top + index / bounds.width) * width + bounds.left + index % bounds.width]
    }
    val body = setOf(BodyPixel)
    val masks = when (action) {
        ClawdAction.IDLE_REST -> listOf(
            LayerMask(ClawdPart.EYES, ClawdPixelRect(320, 325, 704, 406), setOf(EyePixel), BodyPixel),
        )
        ClawdAction.WORKING_TYPING -> listOf(
            // Remove both source-hand blocks; only the outlined keyboard hands are drawn below.
            LayerMask(ClawdPart.LEFT_HAND, ClawdPixelRect(374, 613, 445, 659), body, showOverlay = false),
            LayerMask(ClawdPart.RIGHT_HAND, ClawdPixelRect(818, 560, 870, 624), body, showOverlay = false),
            // Share BASE's cropped canvas and nearest-neighbor sampling grid. A tight laptop crop
            // rounds differently at small screen sizes and can leave a one-pixel transparent seam.
            LayerMask(ClawdPart.LAPTOP, bounds, LaptopPixels, keepSourceInBase = true, trim = false),
        )
        ClawdAction.WAITING_POINT -> listOf(
            LayerMask(ClawdPart.POINT_TIP, ClawdPixelRect(763, 412, 870, 454), body),
        )
        ClawdAction.FINISH_CHEER -> listOf(
            LayerMask(ClawdPart.LEFT_ARM, ClawdPixelRect(153, 330, 245, 420), body, keepBaseBelow = 402),
            LayerMask(ClawdPart.RIGHT_ARM, ClawdPixelRect(778, 330, 870, 420), body, keepBaseBelow = 402),
        )
        ClawdAction.ERROR_ALERT -> listOf(
            LayerMask(ClawdPart.ALERT_MARK, ClawdPixelRect(175, 273, 236, 336), setOf(AlertPixel)),
        )
        ClawdAction.OFFLINE_REST -> emptyList()
        ClawdAction.USAGE_BALL -> listOf(
            LayerMask(ClawdPart.BALL, ClawdPixelRect(725, 607, 870, 773), BallPixels),
            LayerMask(ClawdPart.LEFT_LEG, ClawdPixelRect(250, 612, 356, 713), body),
            LayerMask(ClawdPart.INNER_LEFT_LEG, ClawdPixelRect(370, 612, 490, 713), body),
            LayerMask(ClawdPart.INNER_RIGHT_LEG, ClawdPixelRect(525, 612, 650, 713), body),
            LayerMask(ClawdPart.KICK_LEG, ClawdPixelRect(650, 550, 790, 647), body, keepBaseAbove = 574),
        )
    }
    val overlays = masks.mapNotNull { mask ->
        val pixels = IntArray(mask.bounds.width * mask.bounds.height)
        for (y in mask.bounds.top until mask.bounds.bottom) {
            for (x in mask.bounds.left until mask.bounds.right) {
                val color = source[y * width + x]
                if (color !in mask.colors) continue
                pixels[(y - mask.bounds.top) * mask.bounds.width + x - mask.bounds.left] = color
                if (!mask.keepSourceInBase && y >= mask.keepBaseAbove && y < mask.keepBaseBelow) {
                    base[(y - bounds.top) * bounds.width + x - bounds.left] = mask.replacement
                }
            }
        }
        if (!mask.showOverlay) return@mapNotNull null
        val layer = if (mask.trim) trimLayer(mask.part, mask.bounds, pixels) else ClawdPixelLayer(mask.part, mask.bounds, pixels)
        mask.canvasBounds?.let { padLayer(layer, it) } ?: layer
    }
    val typingHands = if (action == ClawdAction.WORKING_TYPING) listOf(
        typingHand(ClawdPart.LEFT_HAND, ClawdTypingHands.leftBounds, bounds),
        typingHand(ClawdPart.RIGHT_HAND, ClawdTypingHands.rightBounds, bounds),
    ) else emptyList()
    // The fixed laptop stays last so it correctly covers the wrists, never the face.
    return ClawdSplitSprite(action, listOf(ClawdPixelLayer(ClawdPart.BASE, bounds, base)) + typingHands + overlays)
}

private fun typingHand(part: ClawdPart, rect: ClawdPixelRect, canvas: ClawdPixelRect): ClawdPixelLayer {
    val pixels = IntArray(rect.width * rect.height) { index ->
        when (ClawdTypingHands.pattern[index / rect.width / ClawdTypingHands.CELL_SIZE][index % rect.width / ClawdTypingHands.CELL_SIZE]) {
            'B' -> EyePixel
            'H' -> PalmPixel
            else -> 0
        }
    }
    return padLayer(ClawdPixelLayer(part, rect, pixels), canvas)
}

private fun padLayer(layer: ClawdPixelLayer, canvas: ClawdPixelRect): ClawdPixelLayer {
    val pixels = IntArray(canvas.width * canvas.height)
    for (row in 0 until layer.bounds.height) {
        val destination = (layer.bounds.top - canvas.top + row) * canvas.width + layer.bounds.left - canvas.left
        layer.pixels.copyInto(pixels, destination, row * layer.bounds.width, (row + 1) * layer.bounds.width)
    }
    return ClawdPixelLayer(layer.part, canvas, pixels)
}

private fun trimLayer(part: ClawdPart, bounds: ClawdPixelRect, pixels: IntArray): ClawdPixelLayer {
    var left = bounds.width
    var top = bounds.height
    var right = 0
    var bottom = 0
    pixels.forEachIndexed { index, pixel ->
        if (pixel ushr 24 == 0) return@forEachIndexed
        val x = index % bounds.width
        val y = index / bounds.width
        left = minOf(left, x)
        top = minOf(top, y)
        right = maxOf(right, x + 1)
        bottom = maxOf(bottom, y + 1)
    }
    require(right > left && bottom > top) { "Missing $part pixels in key pose" }
    val trimmedWidth = right - left
    return ClawdPixelLayer(
        part,
        ClawdPixelRect(bounds.left + left, bounds.top + top, bounds.left + right, bounds.top + bottom),
        IntArray(trimmedWidth * (bottom - top)) { index ->
            pixels[(top + index / trimmedWidth) * bounds.width + left + index % trimmedWidth]
        },
    )
}
