package com.example.claudephonemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/**
 * Pure code 5x7 Heavy Block Pixel Font renderer for retro print typography.
 * Supports letters, digits, and punctuation for status displays without external font assets.
 */
object PixelFont {
    // 5 wide x 7 high bit patterns (each row is 5 characters: 'X' = on, '.' = off)
    val GLYPHS = mapOf(
        'A' to listOf(
            ".XXX.",
            "X...X",
            "X...X",
            "XXXXX",
            "X...X",
            "X...X",
            "X...X",
        ),
        'B' to listOf(
            "XXXX.",
            "X...X",
            "X...X",
            "XXXX.",
            "X...X",
            "X...X",
            "XXXX.",
        ),
        'C' to listOf(
            ".XXXX",
            "X....",
            "X....",
            "X....",
            "X....",
            "X....",
            ".XXXX",
        ),
        'D' to listOf(
            "XXXX.",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            "XXXX.",
        ),
        'E' to listOf(
            "XXXXX",
            "X....",
            "X....",
            "XXXX.",
            "X....",
            "X....",
            "XXXXX",
        ),
        'F' to listOf(
            "XXXXX",
            "X....",
            "X....",
            "XXXX.",
            "X....",
            "X....",
            "X....",
        ),
        'G' to listOf(
            ".XXXX",
            "X....",
            "X....",
            "X.XXX",
            "X...X",
            "X...X",
            ".XXXX",
        ),
        'H' to listOf(
            "X...X",
            "X...X",
            "X...X",
            "XXXXX",
            "X...X",
            "X...X",
            "X...X",
        ),
        'I' to listOf(
            "XXXXX",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            "XXXXX",
        ),
        'J' to listOf(
            "..XXX",
            "...X.",
            "...X.",
            "...X.",
            "...X.",
            "X..X.",
            ".XX..",
        ),
        'K' to listOf(
            "X...X",
            "X..X.",
            "X.X..",
            "XX...",
            "X.X..",
            "X..X.",
            "X...X",
        ),
        'L' to listOf(
            "X....",
            "X....",
            "X....",
            "X....",
            "X....",
            "X....",
            "XXXXX",
        ),
        'M' to listOf(
            "X...X",
            "XX.XX",
            "X.X.X",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
        ),
        'N' to listOf(
            "X...X",
            "XX..X",
            "X.X.X",
            "X..XX",
            "X...X",
            "X...X",
            "X...X",
        ),
        'O' to listOf(
            ".XXX.",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            ".XXX.",
        ),
        'P' to listOf(
            "XXXX.",
            "X...X",
            "X...X",
            "XXXX.",
            "X....",
            "X....",
            "X....",
        ),
        'Q' to listOf(
            ".XXX.",
            "X...X",
            "X...X",
            "X...X",
            "X.X.X",
            "X..XX",
            ".XX.X",
        ),
        'R' to listOf(
            "XXXX.",
            "X...X",
            "X...X",
            "XXXX.",
            "X.X..",
            "X..X.",
            "X...X",
        ),
        'S' to listOf(
            ".XXXX",
            "X....",
            "X....",
            ".XXX.",
            "....X",
            "....X",
            "XXXX.",
        ),
        'T' to listOf(
            "XXXXX",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
        ),
        'U' to listOf(
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            ".XXX.",
        ),
        'V' to listOf(
            "X...X",
            "X...X",
            "X...X",
            "X...X",
            ".X.X.",
            ".X.X.",
            "..X..",
        ),
        'W' to listOf(
            "X...X",
            "X...X",
            "X...X",
            "X.X.X",
            "X.X.X",
            "XX.XX",
            "X...X",
        ),
        'X' to listOf(
            "X...X",
            ".X.X.",
            "..X..",
            "..X..",
            "..X..",
            ".X.X.",
            "X...X",
        ),
        'Y' to listOf(
            "X...X",
            "X...X",
            ".X.X.",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
        ),
        'Z' to listOf(
            "XXXXX",
            "....X",
            "...X.",
            "..X..",
            ".X...",
            "X....",
            "XXXXX",
        ),
        '0' to listOf(
            ".XXX.",
            "X..XX",
            "X.X.X",
            "XX..X",
            "X...X",
            "X...X",
            ".XXX.",
        ),
        '1' to listOf(
            "..X..",
            ".XX..",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            ".XXX.",
        ),
        '2' to listOf(
            ".XXX.",
            "X...X",
            "....X",
            "..XX.",
            ".X...",
            "X....",
            "XXXXX",
        ),
        '3' to listOf(
            "XXXX.",
            "....X",
            "...X.",
            "..XX.",
            "....X",
            "X...X",
            ".XXX.",
        ),
        '4' to listOf(
            "...X.",
            "..XX.",
            ".X.X.",
            "X..X.",
            "XXXXX",
            "...X.",
            "...X.",
        ),
        '5' to listOf(
            "XXXXX",
            "X....",
            "XXXX.",
            "....X",
            "....X",
            "X...X",
            ".XXX.",
        ),
        '6' to listOf(
            ".XXX.",
            "X....",
            "XXXX.",
            "X...X",
            "X...X",
            "X...X",
            ".XXX.",
        ),
        '7' to listOf(
            "XXXXX",
            "....X",
            "...X.",
            "..X..",
            ".X...",
            ".X...",
            ".X...",
        ),
        '8' to listOf(
            ".XXX.",
            "X...X",
            "X...X",
            ".XXX.",
            "X...X",
            "X...X",
            ".XXX.",
        ),
        '9' to listOf(
            ".XXX.",
            "X...X",
            "X...X",
            ".XXXX",
            "....X",
            "....X",
            ".XXX.",
        ),
        '!' to listOf(
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            "..X..",
            ".....",
            "..X..",
        ),
        '.' to listOf(
            ".....",
            ".....",
            ".....",
            ".....",
            ".....",
            "..X..",
            "..X..",
        ),
        ':' to listOf(
            ".....",
            "..X..",
            "..X..",
            ".....",
            "..X..",
            "..X..",
            ".....",
        ),
        '-' to listOf(
            ".....",
            ".....",
            ".....",
            "XXXXX",
            ".....",
            ".....",
            ".....",
        ),
        ' ' to listOf(
            ".....",
            ".....",
            ".....",
            ".....",
            ".....",
            ".....",
            ".....",
        ),
    )
}

/** Lowercase glyphs keep the mixed-case session labels faithful to the reference. */
private val lowercaseGlyphs = mapOf(
    'a' to listOf(".....", ".....", ".XXX.", "....X", ".XXXX", "X...X", ".XXXX"),
    'b' to listOf("X....", "X....", "XXXX.", "X...X", "X...X", "X...X", "XXXX."),
    'c' to listOf(".....", ".....", ".XXXX", "X....", "X....", "X....", ".XXXX"),
    'd' to listOf("....X", "....X", ".XXXX", "X...X", "X...X", "X...X", ".XXXX"),
    'e' to listOf(".....", ".....", ".XXX.", "X...X", "XXXXX", "X....", ".XXXX"),
    'f' to listOf("..XX.", ".X..X", ".X...", "XXX..", ".X...", ".X...", ".X..."),
    'g' to listOf(".....", ".XXXX", "X...X", "X...X", ".XXXX", "....X", ".XXX."),
    'h' to listOf("X....", "X....", "XXXX.", "X...X", "X...X", "X...X", "X...X"),
    'i' to listOf("..X..", ".....", ".XX..", "..X..", "..X..", "..X..", ".XXX."),
    'j' to listOf("...X.", ".....", "..XX.", "...X.", "...X.", "X..X.", ".XX.."),
    'k' to listOf("X....", "X....", "X..X.", "X.X..", "XX...", "X.X..", "X..X."),
    'l' to listOf(".XX..", "..X..", "..X..", "..X..", "..X..", "..X..", ".XXX."),
    'm' to listOf(".....", ".....", "XX.X.", "X.X.X", "X.X.X", "X...X", "X...X"),
    'n' to listOf(".....", ".....", "XXXX.", "X...X", "X...X", "X...X", "X...X"),
    'o' to listOf(".....", ".....", ".XXX.", "X...X", "X...X", "X...X", ".XXX."),
    'p' to listOf(".....", "XXXX.", "X...X", "X...X", "XXXX.", "X....", "X...."),
    'q' to listOf(".....", ".XXXX", "X...X", "X...X", ".XXXX", "....X", "....X"),
    'r' to listOf(".....", ".....", "X.XX.", "XX..X", "X....", "X....", "X...."),
    's' to listOf(".....", ".....", ".XXXX", "X....", ".XXX.", "....X", "XXXX."),
    't' to listOf(".X...", ".X...", "XXX..", ".X...", ".X...", ".X..X", "..XX."),
    'u' to listOf(".....", ".....", "X...X", "X...X", "X...X", "X..XX", ".XX.X"),
    'v' to listOf(".....", ".....", "X...X", "X...X", "X...X", ".X.X.", "..X.."),
    'w' to listOf(".....", ".....", "X...X", "X...X", "X.X.X", "X.X.X", ".X.X."),
    'x' to listOf(".....", ".....", "X...X", ".X.X.", "..X..", ".X.X.", "X...X"),
    'y' to listOf(".....", "X...X", "X...X", ".XXXX", "....X", "X...X", ".XXX."),
    'z' to listOf(".....", ".....", "XXXXX", "...X.", "..X..", ".X...", "XXXXX"),
    '?' to listOf(".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."),
)

internal data class PixelTextGeometry(val width: Float, val height: Float, val scale: Float)

/** One uniform scale keeps the final glyph complete under both width and height constraints. */
internal fun calculatePixelTextGeometry(
    characterCount: Int,
    pixelSize: Float,
    gap: Float,
    charSpacing: Int,
    maxWidth: Float = Float.POSITIVE_INFINITY,
    maxHeight: Float = Float.POSITIVE_INFINITY,
): PixelTextGeometry {
    if (characterCount <= 0 || pixelSize <= 0f) return PixelTextGeometry(0f, 0f, 1f)
    val step = pixelSize + gap.coerceAtLeast(0f)
    val width = ((characterCount * 5 + (characterCount - 1) * charSpacing.coerceAtLeast(0)) - 1) * step + pixelSize
    val height = 6 * step + pixelSize
    val scale = minOf(1f, maxWidth.coerceAtLeast(0f) / width, maxHeight.coerceAtLeast(0f) / height)
    return PixelTextGeometry(width * scale, height * scale, scale)
}

/** Measured, accessible single-line bitmap text. Sizes in sp follow Android font scaling. */
@Composable
fun PixelText(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    textHeight: TextUnit = 14.sp,
) {
    val density = LocalDensity.current
    val pixelSize = with(density) { textHeight.toPx() } / 7f
    MeasuredPixelText(text, color, modifier, pixelSize, 0f, 1)
}

/** Compatibility entry point for callers specifying physical pixel block dimensions. */
@Composable
fun LargePixelText(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    pixelSize: Dp = 10.dp,
    gap: Dp = 1.dp,
    charSpacing: Int = 2,
) {
    val density = LocalDensity.current
    MeasuredPixelText(
        text, color, modifier,
        with(density) { pixelSize.toPx() }, with(density) { gap.toPx() }, charSpacing,
    )
}

@Composable
private fun MeasuredPixelText(
    text: String,
    color: Color,
    modifier: Modifier,
    pixelSize: Float,
    gap: Float,
    charSpacing: Int,
) {
    Layout(
        modifier = modifier.semantics { contentDescription = text },
        content = {
            Canvas(Modifier.fillMaxSize()) {
                val geometry = calculatePixelTextGeometry(
                    text.length, pixelSize, gap, charSpacing, size.width, size.height,
                )
                val px = pixelSize * geometry.scale
                val step = (pixelSize + gap.coerceAtLeast(0f)) * geometry.scale
                val top = (size.height - geometry.height) / 2f
                text.forEachIndexed { index, character ->
                    val glyph = lowercaseGlyphs[character] ?: PixelFont.GLYPHS[character] ?: lowercaseGlyphs.getValue('?')
                    glyph.forEachIndexed { row, columns ->
                        columns.forEachIndexed { column, point ->
                            if (point == 'X') drawRect(
                                color = color,
                                topLeft = Offset(index * (5 + charSpacing.coerceAtLeast(0)) * step + column * step, top + row * step),
                                size = Size(px, px),
                            )
                        }
                    }
                }
            }
        },
    ) { measurables, constraints ->
        val geometry = calculatePixelTextGeometry(
            text.length, pixelSize, gap, charSpacing,
            if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() else Float.POSITIVE_INFINITY,
            if (constraints.hasBoundedHeight) constraints.maxHeight.toFloat() else Float.POSITIVE_INFINITY,
        )
        val width = constraints.constrainWidth(kotlin.math.ceil(geometry.width).toInt())
        val height = constraints.constrainHeight(kotlin.math.ceil(geometry.height).toInt())
        val placeable = measurables.single().measure(androidx.compose.ui.unit.Constraints.fixed(width, height))
        layout(width, height) { placeable.place(0, 0) }
    }
}
