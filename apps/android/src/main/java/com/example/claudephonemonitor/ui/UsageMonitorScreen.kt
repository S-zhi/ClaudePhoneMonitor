package com.example.claudephonemonitor.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.testTag
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.UsageAggregate
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageMetric
import com.example.claudephonemonitor.monitor.UsageQuality
import java.time.Instant
import java.util.Locale
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.coroutines.delay

@Composable
internal fun UsageMonitorScreen(
    uiState: MonitorUiState,
    onReturnToStatus: () -> Unit,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val usage = uiState.snapshot.usage
    val presentation = usagePresentation(uiState)
    BackHandler(onBack = onReturnToStatus)
    BoxWithConstraints(modifier = modifier.background(MaterialTheme.colorScheme.background).testTag("usage-root")) {
        val useCompact = compact || maxHeight < 440.dp
        val largeFont = LocalDensity.current.fontScale > 1.35f
        val horizontalPadding = if (useCompact) 12.dp else 20.dp
        val topHeight = if (useCompact) 42.dp else 52.dp
        val dialHeight = (maxHeight * when {
            useCompact && largeFont -> 0.48f
            useCompact -> 0.38f
            else -> 0.34f
        })
            .coerceIn(if (useCompact) 118.dp else 176.dp, if (useCompact) 152.dp else 230.dp)
        val dialDiameter = (dialHeight - if (useCompact && largeFont) 46.dp else 42.dp)
            .coerceIn(if (useCompact && largeFont) 68.dp else if (useCompact) 78.dp else 132.dp, if (useCompact) 116.dp else 188.dp)
        val footerHeight = when {
            presentation.showSetup -> 42.dp
            largeFont -> 40.dp
            else -> 30.dp
        }
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = horizontalPadding, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().height(topHeight),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Button(
                    onClick = onReturnToStatus,
                    modifier = Modifier.heightIn(min = 40.dp),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF342D28), contentColor = Color(0xFFF1E8DE)),
                ) { Text("‹ 状态", fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                Text("Usage 用量消耗", modifier = Modifier.weight(1f).testTag("usage-title"), color = MaterialTheme.colorScheme.onSurface,
                    fontSize = if (useCompact) 17.sp else 21.sp, lineHeight = if (useCompact) 19.sp else 23.sp,
                    fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                UsageRelayInfo(uiState.isConnected, uiState.snapshot.computerState, usage?.collectorStartedAt)
            }
            Row(
                modifier = Modifier.fillMaxWidth().height(dialHeight),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                UsageQuotaDial(usage, Modifier.weight(0.38f).fillMaxHeight().testTag("usage-quota"), compact = useCompact, diameter = dialDiameter)
                UsageMetrics(usage, Modifier.weight(0.62f).fillMaxHeight().testTag("usage-metrics"), compact = useCompact)
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Color(0xFF493F35)))
            UsagePlayground(modifier = Modifier.fillMaxWidth().weight(1f)
                .heightIn(min = if (useCompact && largeFont) 48.dp else 68.dp).testTag("usage-playground"))
            Row(
                modifier = Modifier.fillMaxWidth().height(footerHeight),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(formatUsageRangeLabel(usage),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp, lineHeight = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).testTag("usage-range"))
                Text(presentation.freshnessLabel, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp,
                    lineHeight = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 8.dp).testTag("usage-freshness"), textAlign = TextAlign.End)
            }
        }
    }
}

@Composable
private fun UsageRelayInfo(connected: Boolean, computerState: ComputerState, collectorStartedAt: String?) {
    var nowMillis by remember(collectorStartedAt) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(collectorStartedAt) {
        if (collectorStartedAt != null) {
            while (true) {
                delay(60_000L)
                nowMillis = System.currentTimeMillis()
            }
        }
    }
    Column(horizontalAlignment = Alignment.End) {
        val status = when {
            !connected && computerState == ComputerState.OFFLINE -> "Relay 离线 · Mac 离线"
            !connected -> "Relay 离线"
            computerState == ComputerState.OFFLINE -> "Relay 已连接 · Mac 离线"
            computerState == ComputerState.STALE -> "Relay 已连接 · 数据过期"
            else -> "Relay 已连接"
        }
        Text(status, color = if (connected && computerState == ComputerState.ONLINE) Color(0xFF8DE6A8) else Color(0xFFF6C76D),
            fontSize = 11.sp, lineHeight = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(collectorStartedAt?.let { formatCollectorRuntime(it, nowMillis) } ?: "服务时长 —",
            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp, lineHeight = 11.sp, maxLines = 1)
    }
}

@Composable
private fun UsageQuotaDial(usage: UsageAggregate?, modifier: Modifier = Modifier, compact: Boolean, diameter: androidx.compose.ui.unit.Dp) {
    val fraction = quotaRemainingFraction(usage)
    val startFraction = quotaStartFraction(usage)
    val largeFont = LocalDensity.current.fontScale > 1.35f
    val progress = remember { Animatable(fraction ?: 0f) }
    LaunchedEffect(fraction) {
        if (fraction != null) progress.animateTo(fraction, tween(durationMillis = 650)) else progress.snapTo(0f)
    }
    Column(modifier.padding(end = if (compact) 8.dp else 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(diameter), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val radius = size.minDimension * 0.39f
                drawArc(Color(0xFF493F35), 135f, 270f, false, Offset(center.x-radius, center.y-radius), Size(radius*2, radius*2), style = Stroke(6.dp.toPx()))
                if (fraction != null) {
                    drawArc(Color(0xFF90BE82), 135f, 270f * progress.value, false, Offset(center.x-radius, center.y-radius), Size(radius*2, radius*2), style = Stroke(6.dp.toPx()))
                    if (startFraction != null) {
                        val angle = Math.toRadians(135.0 + startFraction * 270f)
                        drawCircle(Color(0xFFD97757), 4.dp.toPx(), Offset(center.x + cos(angle).toFloat()*radius, center.y + sin(angle).toFloat()*radius))
                    }
                    val currentAngle = Math.toRadians(135.0 + fraction * 270f)
                    drawCircle(Color(0xFFF1E8DE), 3.dp.toPx(), Offset(center.x + cos(currentAngle).toFloat()*radius, center.y + sin(currentAngle).toFloat()*radius))
                }
                for (index in 0..40) {
                    val angle = Math.toRadians(135.0 + index * 270.0 / 40.0)
                    val outer = size.minDimension * 0.49f
                    val inner = outer - (if (index % 10 == 0) 6.dp.toPx() else 3.dp.toPx())
                    drawLine(Color(0xFF877A6A), Offset(center.x+cos(angle).toFloat()*inner, center.y+sin(angle).toFloat()*inner), Offset(center.x+cos(angle).toFloat()*outer, center.y+sin(angle).toFloat()*outer), strokeWidth=1.dp.toPx())
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                val percentSize = if (compact && largeFont) 10.sp else if (compact) 16.sp else 32.sp
                Text(usage?.quota?.currentRemaining?.let(::formatQuotaPercent) ?: "—", color = MaterialTheme.colorScheme.onSurface,
                    fontSize = percentSize, lineHeight = (percentSize.value * 1.1f).sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("usage-quota-percent"))
                val status = when {
                    usage?.quota?.availability == "stale" && fraction != null -> "上次剩余"
                    usage?.quota?.availability == "stale" -> "额度过期"
                    fraction == null -> "额度不可用"
                    else -> "当前剩余"
                }
                val statusSize = if (compact && largeFont) 7.sp else 11.sp
                Text(status, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = statusSize,
                    lineHeight = (statusSize.value * 1.1f).sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("usage-quota-status"))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            val alignedStart = quotaStartFraction(usage)?.let { usage?.quota?.startRemaining?.let(::formatQuotaPercent) } ?: "—"
            val quota = usage?.quota
            val current = quota?.currentRemaining?.let(::formatQuotaPercent) ?: "—"
            val legendSize = if (compact && largeFont) 7.sp else 8.sp
            val legendLineHeight = if (compact && largeFont) 8.sp else 9.sp
            Text("○ 启动时 $alignedStart", color = Color(0xFFD97757), fontSize = legendSize, lineHeight = legendLineHeight, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("usage-quota-start-legend"))
            Text(" · ", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = legendSize, lineHeight = legendLineHeight)
            Text("● ${if (quota?.availability == "stale") "上次" else "当前"} $current", color = Color(0xFFF1E8DE), fontSize = legendSize, lineHeight = legendLineHeight, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("usage-quota-current-legend"))
        }
        val windowSize = if (compact && largeFont) 7.sp else 9.sp
        Text(formatQuotaWindow(usage) ?: if (usage?.quota?.availability == "stale") "额度数据过期" else "剩余额度",
            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = windowSize,
            lineHeight = if (compact && largeFont) 8.sp else 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag("usage-quota-window"))
    }
}

internal fun quotaRemainingFraction(usage: UsageAggregate?): Float? {
    val quota = usage?.quota ?: return null
    if (quota.availability != "available" && quota.availability != "stale") return null
    if (quota.unit != "percent") return null
    val current = quota.currentRemaining ?: return null
    if (current !in 0.0..100.0) return null
    return (current / 100.0).toFloat()
}

internal fun quotaStartFraction(usage: UsageAggregate?): Float? {
    val quota = usage?.quota ?: return null
    if (!quotaResetTimesAlign(quota.startResetAt, quota.resetAt)) return null
    if (quota.window.isNullOrBlank() || quota.windowMinutes == null || quota.windowMinutes <= 0) return null
    if (quota.startSampledAt.isNullOrBlank()) return null
    if (runCatching { Instant.parse(quota.startSampledAt) }.isFailure) return null
    if (quota.availability != "available" && quota.availability != "stale") return null
    if (quota.unit != "percent") return null
    val start = quota.startRemaining ?: return null
    if (start !in 0.0..100.0) return null
    return (start / 100.0).toFloat()
}

private fun quotaResetTimesAlign(startResetAt: String?, resetAt: String?): Boolean {
    if (startResetAt.isNullOrBlank() || resetAt.isNullOrBlank()) return false
    val startMillis = runCatching { Instant.parse(startResetAt).toEpochMilli() }.getOrNull() ?: return false
    val currentMillis = runCatching { Instant.parse(resetAt).toEpochMilli() }.getOrNull() ?: return false
    val delta = runCatching { Math.subtractExact(startMillis, currentMillis) }.getOrNull() ?: return false
    return delta in -5_000L..5_000L
}

private fun formatQuotaWindow(usage: UsageAggregate?): String? {
    val quota = usage?.quota ?: return null
    val minutes = quota.windowMinutes ?: return null
    val duration = when {
        minutes % (24 * 60) == 0 -> "${minutes / (24 * 60)}天"
        minutes % 60 == 0 -> "${minutes / 60}小时"
        else -> "${minutes}分"
    }
    val reset = quota.resetAt?.let(::formatUsageStartedAt) ?: return duration
    val source = if (quota.limitId == "codex") "Codex · " else ""
    val stalePrefix = if (quota.availability == "stale") "上次 · " else ""
    return "${stalePrefix}${source}${duration}额度 · ${reset}重置"
}

private fun formatQuotaPercent(value: Double): String =
    if (value % 1.0 == 0.0) String.format(Locale.US, "%.0f%%", value)
    else String.format(Locale.US, "%.1f%%", value)

internal fun formatCacheHitScope(usage: UsageAggregate): String {
    val cache = usage.cacheHit
    val providers = cache.providers ?: run {
        val allComplete = usage.claudeCoverage.status == UsageCoverageStatus.READY &&
            usage.codexCoverage.status == UsageCoverageStatus.READY &&
            usage.claudeCoverage.completeResponses == usage.claudeCoverage.observedResponses &&
            usage.codexCoverage.completeResponses == usage.codexCoverage.observedResponses &&
            usage.completeResponses == usage.observedResponses
        return if (allComplete && cache.quality == UsageQuality.COMPLETE && formatCacheHitRate(usage) != "不可用") "Claude + Codex" else ""
    }
    val names = providers.joinToString(" + ") { if (it == "codex") "Codex" else "Claude" }
    return if (cache.quality == UsageQuality.PARTIAL) "完整 $names 响应 · 部分覆盖" else names
}

@Composable
private fun UsageMetrics(usage: UsageAggregate?, modifier: Modifier = Modifier, compact: Boolean) {
    val largeFont = LocalDensity.current.fontScale > 1.35f
    val valueSize = if (compact && largeFont) 14 else if (compact) 22 else 30
    val gap = if (compact) 6.dp else 12.dp
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(gap)) {
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(gap)) {
            UsageMetricDisplay("真实消耗 Tokens", usage?.actual?.let(::formatUsageMetric) ?: "不可用", Color(0xFFD97757), valueSize, if (largeFont) 9 else 11, Modifier.weight(1f).fillMaxHeight(), "usage-value-actual")
            Column(Modifier.weight(1f).fillMaxHeight()) {
                val rate = usage?.let(::formatCacheHitRate) ?: "不可用"
                Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center) {
                    UsageMetricDisplay("缓存命中率", rate, Color(0xFFA5C595), valueSize, if (largeFont) 9 else 11, Modifier.fillMaxWidth(), "usage-value-cache-hit")
                    val scope = usage?.takeIf { rate != "不可用" }?.let(::formatCacheHitScope).orEmpty()
                    if (scope.isNotBlank()) Text(scope, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = (if (largeFont) 7 else 9).sp, lineHeight = (if (largeFont) 8 else 10).sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.fillMaxWidth().height(if (largeFont) 3.dp else 4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0xFF493F35))) {
                    if (rate != "不可用" && usage != null) {
                        val fraction = usage.cacheHit.numerator!!.toDouble() / usage.cacheHit.denominator!!.toDouble()
                        Box(Modifier.fillMaxWidth(fraction.toFloat().coerceIn(0f, 1f)).fillMaxHeight().background(Color(0xFFA5C595)))
                    }
                }
            }
        }
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(gap)) {
            UsageMetricDisplay("新增输入 Tokens", usage?.newInput?.let(::formatUsageMetric) ?: "不可用", MaterialTheme.colorScheme.onSurface, valueSize, if (largeFont) 9 else 11, Modifier.weight(1f).fillMaxHeight(), "usage-value-new-input")
            UsageMetricDisplay("总请求数", usage?.let(::formatObservedResponses) ?: "不可用", MaterialTheme.colorScheme.onSurface, valueSize, if (largeFont) 9 else 11, Modifier.weight(1f).fillMaxHeight(), "usage-value-request-count")
        }
    }
}

@Composable
private fun UsageMetricDisplay(
    label: String,
    value: String,
    valueColor: Color,
    valueSizeSp: Int,
    labelSizeSp: Int,
    modifier: Modifier = Modifier,
    valueTag: String,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.Center) {
        Text(label, color = MaterialTheme.colorScheme.onSurface, fontSize = labelSizeSp.sp,
            lineHeight = (labelSizeSp * 1.1f).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val renderedValueSize = if (value.length > 12) 13 else valueSizeSp
        Text(value, color = valueColor, fontFamily = FontFamily.Monospace,
            fontSize = renderedValueSize.sp, lineHeight = (renderedValueSize * 1.1f).sp,
            fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(valueTag))
    }
}

internal fun formatUsageMetric(metric: UsageMetric): String {
    if (metric.quality == UsageQuality.UNAVAILABLE) return "不可用"
    val value = metric.value ?: return "不可用"
    return formatTokenCount(value)
}

private fun formatTokenCount(value: Long): String = String.format(Locale.US, "%,d", value)

internal fun formatCacheHitRate(usage: UsageAggregate): String {
    val cache = usage.cacheHit
    val numerator = cache.numerator ?: return "不可用"
    val denominator = cache.denominator ?: return "不可用"
    if (denominator <= 0L || numerator < 0L || numerator > denominator) return "不可用"
    val providers = cache.providers
    if (cache.sampleResponses == 0L) return "不可用"
    if (cache.quality == UsageQuality.PARTIAL) {
        if (providers.isNullOrEmpty() || cache.sampleResponses == null || cache.sampleResponses <= 0L) return "不可用"
        return "约" + String.format(Locale.US, "%.0f%%", numerator.toDouble() * 100.0 / denominator)
    }
    if (cache.quality != UsageQuality.COMPLETE) return "不可用"
    val scopedProvidersComplete = providers?.all { provider ->
        val coverage = if (provider == "codex") usage.codexCoverage else usage.claudeCoverage
        coverage.status == UsageCoverageStatus.READY && coverage.completeResponses == coverage.observedResponses
    }
    val complete = if (scopedProvidersComplete != null) {
        scopedProvidersComplete
    } else {
        usage.claudeCoverage.status == UsageCoverageStatus.READY &&
            usage.codexCoverage.status == UsageCoverageStatus.READY &&
            usage.claudeCoverage.completeResponses == usage.claudeCoverage.observedResponses &&
            usage.codexCoverage.completeResponses == usage.codexCoverage.observedResponses &&
            usage.completeResponses == usage.observedResponses &&
            usage.totalInput.quality == UsageQuality.COMPLETE
    }
    if (!complete) return "不可用"
    return String.format(Locale.US, "%.1f%%", numerator.toDouble() * 100.0 / denominator)
}

internal fun formatObservedResponses(usage: UsageAggregate): String {
    return formatTokenCount(usage.observedResponses)
}

private fun responseCountQuality(usage: UsageAggregate): UsageQuality =
    if (usage.claudeCoverage.status == UsageCoverageStatus.READY && usage.codexCoverage.status == UsageCoverageStatus.READY) {
        UsageQuality.COMPLETE
    } else {
        UsageQuality.PARTIAL
    }
