package com.example.claudephonemonitor.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

internal val ClawdKeyPoseKey = SemanticsPropertyKey<String>("ClawdKeyPose")
internal var SemanticsPropertyReceiver.clawdKeyPose by ClawdKeyPoseKey
internal val ClawdImageReadyKey = SemanticsPropertyKey<Boolean>("ClawdImageReady")
internal var SemanticsPropertyReceiver.clawdImageReady by ClawdImageReadyKey
internal val ClawdAnimationTimeKey = SemanticsPropertyKey<Long>("ClawdAnimationTime")
internal var SemanticsPropertyReceiver.clawdAnimationTime by ClawdAnimationTimeKey

internal data class ClawdSpriteImages(
    val geometry: ClawdSpriteGeometry,
    val images: Map<ClawdPart, ImageBitmap>,
    val byteCount: Int,
)

/** Cropped images only: a bounded 6 MiB cache, with no asset reads / decoding in the drawing loop. */
internal object ClawdImageCache {
    private val cache = object : LruCache<ClawdAction, ClawdSpriteImages>(6 * 1_024 * 1_024) {
        override fun sizeOf(key: ClawdAction, value: ClawdSpriteImages): Int = value.byteCount
    }

    @Synchronized
    fun load(context: Context, action: ClawdAction): ClawdSpriteImages {
        cache.get(action)?.let { return it }
        val source = context.assets.open(action.assetPath).use { input ->
            checkNotNull(BitmapFactory.decodeStream(input, null, BitmapFactory.Options().apply {
                inScaled = false
                inPreferredConfig = Bitmap.Config.ARGB_8888
            })) { "Invalid Clawd key pose: ${action.assetPath}" }
        }
        val pixels = IntArray(source.width * source.height)
        source.getPixels(pixels, 0, source.width, 0, 0, source.width, source.height)
        val split = try {
            splitClawdKeyPose(action, source.width, source.height, pixels)
        } finally {
            source.recycle()
        }
        val runtimeSplit = if (action == ClawdAction.USAGE_BALL) {
            val prop = context.assets.open(ClawdUsageBallAssetPath).use { input ->
                checkNotNull(BitmapFactory.decodeStream(input, null, BitmapFactory.Options().apply {
                    inScaled = false
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                })) { "Invalid complete Usage ball" }
            }
            val propPixels = IntArray(prop.width * prop.height)
            prop.getPixels(propPixels, 0, prop.width, 0, 0, prop.width, prop.height)
            try {
                replaceClawdUsageBall(split, prop.width, prop.height, propPixels)
            } finally {
                prop.recycle()
            }
        } else split
        val images = runtimeSplit.layers.associate { layer ->
            layer.part to Bitmap.createBitmap(
                layer.pixels, layer.bounds.width, layer.bounds.height, Bitmap.Config.ARGB_8888,
            ).asImageBitmap()
        }
        return ClawdSpriteImages(runtimeSplit.geometry, images, runtimeSplit.layers.sumOf { it.pixels.size * 4 }).also {
            cache.put(action, it)
        }
    }
}

@Composable
internal fun rememberClawdSprite(action: ClawdAction): State<ClawdSpriteImages?> {
    val context = LocalContext.current.applicationContext
    val result = remember(context, action) { mutableStateOf<ClawdSpriteImages?>(null) }
    LaunchedEffect(context, action) {
        result.value = withContext(Dispatchers.IO) { ClawdImageCache.load(context, action) }
    }
    return result
}

/**
 * One sampled, vsync-yielding clock. OFFLINE / silent poses create no loop. Lifecycle cancellation
 * pauses it in the background; leaving the page disposes it, and a new action starts at zero.
 */
@Composable
internal fun rememberClawdAnimationTimeState(action: ClawdAction, isSilent: Boolean = false): State<Long> {
    val owner = LocalLifecycleOwner.current
    val elapsed = remember(action, isSilent) { mutableLongStateOf(0L) }
    LaunchedEffect(action, isSilent, owner) {
        if (isSilent || action.frameIntervalMs == 0L) return@LaunchedEffect
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var previous = withInfiniteAnimationFrameNanos { it }
            while (isActive) {
                // This suspends until a display frame. It cannot spin or produce a busy loop.
                val now = withInfiniteAnimationFrameNanos { it }
                val deltaMs = (now - previous) / 1_000_000L
                if (deltaMs >= action.frameIntervalMs) {
                    elapsed.longValue = (elapsed.longValue + deltaMs) % action.cycleMs
                    previous = now
                }
            }
        }
    }
    return elapsed
}

/** Convenience for composables that intentionally observe the clock during composition. */
@Composable
internal fun rememberClawdAnimationTime(action: ClawdAction, isSilent: Boolean = false): Long =
    rememberClawdAnimationTimeState(action, isSilent).value

internal fun DrawScope.drawClawdLayers(images: ClawdSpriteImages, placements: List<ClawdLayerPlacement>) {
    placements.forEach { placement ->
        val bitmap = images.images.getValue(placement.part)
        val drawLayer: DrawScope.() -> Unit = {
            drawImage(
                image = bitmap,
                dstOffset = IntOffset(placement.left, placement.top),
                dstSize = IntSize(placement.width, placement.height),
                alpha = placement.alpha,
                filterQuality = FilterQuality.None,
            )
        }
        if (placement.mirrored || placement.rotationDegrees != 0f) {
            withTransform({
                val pivot = Offset(placement.left + placement.width / 2f, placement.top + placement.height / 2f)
                if (placement.rotationDegrees != 0f) rotate(placement.rotationDegrees, pivot)
                if (placement.mirrored) scale(-1f, 1f, pivot)
            }, drawLayer)
        } else {
            drawLayer()
        }
    }
}
