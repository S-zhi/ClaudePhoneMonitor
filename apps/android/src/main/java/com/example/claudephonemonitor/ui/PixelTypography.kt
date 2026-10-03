package com.example.claudephonemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

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

/**
 * Renders large retro print pixel typography on Compose Canvas.
 */
@Composable
fun LargePixelText(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    pixelSize: Dp = 10.dp,
    gap: Dp = 1.dp,
    charSpacing: Int = 2,
) {
    val upper = text.uppercase()
    val glyphRows = 7
    val glyphCols = 5

    Canvas(modifier = modifier) {
        val px = pixelSize.toPx()
        val spacing = gap.toPx()
        val step = px + spacing

        var currentX = 0f
        for (char in upper) {
            val glyph = PixelFont.GLYPHS[char] ?: PixelFont.GLYPHS[' ']!!
            for (r in 0 until glyphRows) {
                val rowStr = glyph[r]
                for (c in 0 until glyphCols) {
                    if (rowStr[c] == 'X') {
                        drawRect(
                            color = color,
                            topLeft = Offset(currentX + c * step, r * step),
                            size = Size(px, px),
                        )
                    }
                }
            }
            currentX += (glyphCols + charSpacing) * step
        }
    }
}
