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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.UsageAggregate
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageMetric
import com.example.claudephonemonitor.monitor.UsageQuality
import java.util.Locale
import kotlin.math.cos
import kotlin.math.sin

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
    BoxWithConstraints(modifier = modifier) {
    val useCompact = compact || maxHeight < 440.dp
    val playgroundHeight = if (useCompact) (maxHeight - 231.dp).coerceIn(80.dp, 116.dp) else (maxHeight - 279.dp).coerceIn(120.dp, 190.dp)
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = if (useCompact) 12.dp else 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                onClick = onReturnToStatus,
                modifier = Modifier.heightIn(min = 44.dp),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF342D28),
                    contentColor = Color(0xFFF1E8DE),
                ),
            ) {
                Text("返回状态", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            Column(Modifier.weight(1f)) {
                Text("Usage 用量消耗", color = MaterialTheme.colorScheme.onSurface, fontSize = if (useCompact) 17.sp else 21.sp, fontWeight = FontWeight.Bold)
                usage?.let { Text("累计自首次启用 ${formatUsageStartedAt(it.startedAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp) }
            }
            Text(
                presentation.connectionLabel,
                modifier = Modifier.widthIn(max = if (useCompact) 170.dp else 270.dp),
                color = if (uiState.isConnected && uiState.snapshot.computerState == ComputerState.ONLINE) Color(0xFF8DE6A8) else Color(0xFFF6C76D),
                fontSize = 11.sp,
            )
        }

        Column(
            modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (presentation.showSetup) {
                Text(presentation.collectionTitle, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                UsageSetupHint()
            }
            Row(
                modifier = Modifier.fillMaxWidth().height(if (useCompact) 142.dp else 190.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                UsageQuotaDial(
                    modifier = Modifier.weight(0.40f).fillMaxHeight(),
                    compact = useCompact,
                )
                UsageMetrics(
                    usage = usage,
                    modifier = Modifier.weight(0.60f).fillMaxHeight(),
                    compact = useCompact,
                )
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Color(0xFF493F35)))
            UsagePlayground(modifier = Modifier.fillMaxWidth().height(playgroundHeight))
            Text(presentation.collectionTitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
            if (usage != null) Text(presentation.collectionDetail, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp)
            UsageCoverageAndCache(usage, Modifier.fillMaxWidth())
        }
    }
    }
}

@Composable
private fun UsageSetupHint() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text("在 Mac 项目目录运行", color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp)
        Text(USAGE_START_COMMAND, color = MaterialTheme.colorScheme.primary, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        Text(
            "也可双击启动器，首次选择启用 Usage。若启动器已在运行，先停止后用上述命令启用并保存选择。启用后需产生新的模型响应，首次启用前不回填历史。",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 11.sp,
            lineHeight = 16.sp,
        )
    }
}

@Composable
private fun UsageQuotaDial(modifier: Modifier = Modifier, compact: Boolean) {
    Column(
        modifier = modifier.padding(end = if (compact) 10.dp else 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(modifier = Modifier.size(if (compact) 114.dp else 158.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val radius = size.minDimension * 0.39f
                drawArc(Color(0xFF493F35), 135f, 270f, false, Offset(center.x - radius, center.y - radius), Size(radius * 2f, radius * 2f), style = Stroke(5.dp.toPx()))
                for (index in 0..40) {
                    val angle = Math.toRadians(135.0 + index * 270.0 / 40.0)
                    val outer = size.minDimension * 0.49f
                    val inner = outer - (if (index % 10 == 0) 6.dp.toPx() else 3.dp.toPx())
                    drawLine(
                        Color(0xFF877A6A),
                        Offset(center.x + cos(angle).toFloat() * inner, center.y + sin(angle).toFloat() * inner),
                        Offset(center.x + cos(angle).toFloat() * outer, center.y + sin(angle).toFloat() * outer),
                        strokeWidth = 1.dp.toPx(),
                    )
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("不可用", color = MaterialTheme.colorScheme.onSurface, fontSize = if (compact) 20.sp else 28.sp, fontWeight = FontWeight.Bold)
                Text("当前剩余", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
                Text("无可信额度源", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp)
            }
        }
        Text("○ 启动时：不可用   ● 当前：不可用", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp)
    }
}

@Composable
private fun UsageMetrics(usage: UsageAggregate?, modifier: Modifier = Modifier, compact: Boolean) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            UsageMetricDisplay("实际消耗 Tokens", usage?.actual?.let(::formatUsageMetric) ?: "不可用", usage?.actual?.quality, Color(0xFFD97757), compact, Modifier.weight(1f).fillMaxHeight())
            Column(Modifier.weight(1f).fillMaxHeight()) {
                val rate = usage?.let(::formatCacheHitRate) ?: "不可用"
                UsageMetricDisplay("缓存命中率", rate, if (rate == "不可用") UsageQuality.UNAVAILABLE else UsageQuality.COMPLETE, Color(0xFFA5C595), compact, Modifier.weight(1f).fillMaxWidth())
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0xFF493F35))) {
                    if (rate != "不可用" && usage != null) {
                        val fraction = usage.cacheHit.numerator!!.toDouble() / usage.cacheHit.denominator!!.toDouble()
                        Box(Modifier.fillMaxWidth(fraction.toFloat().coerceIn(0f, 1f)).fillMaxHeight().background(Color(0xFFA5C595)))
                    }
                }
            }
        }
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            UsageMetricDisplay("新增输入 Tokens", usage?.newInput?.let(::formatUsageMetric) ?: "不可用", usage?.newInput?.quality, MaterialTheme.colorScheme.onSurface, compact, Modifier.weight(1f).fillMaxHeight())
            UsageMetricDisplay("总请求数", usage?.let(::formatObservedResponses) ?: "不可用", usage?.let(::responseCountQuality), MaterialTheme.colorScheme.onSurface, compact, Modifier.weight(1f).fillMaxHeight())
        }
    }
}

@Composable
private fun UsageMetricDisplay(
    label: String,
    value: String,
    quality: UsageQuality?,
    valueColor: Color,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.Center) {
        Text(label, color = MaterialTheme.colorScheme.onSurface, fontSize = 11.sp)
        Text(value, color = valueColor, fontFamily = FontFamily.Monospace, fontSize = if (value.length > 12) 13.sp else if (compact) 22.sp else 30.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (quality == UsageQuality.PARTIAL) Text("已确认下界 · 部分数据", color = Color(0xFFF6C76D), fontSize = 10.sp)
    }
}

@Composable
private fun UsageCoverageAndCache(usage: UsageAggregate?, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(usageCacheExplanation(usage), color = MaterialTheme.colorScheme.onSurface, fontSize = 11.sp)
        Text(
            "实际消耗 = 新增输入 + 输出；缓存读取单独列示。总请求数是已观测模型响应，内部重试不可见。",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 11.sp,
            lineHeight = 15.sp,
        )
        ProviderCoverageLabel(formatProviderCoverage("Claude", usage?.claudeCoverage), usage?.claudeCoverage?.status)
        ProviderCoverageLabel(formatProviderCoverage("Codex", usage?.codexCoverage), usage?.codexCoverage?.status)
        if (usage != null && formatCacheHitRate(usage) == "不可用") {
            Text("命中率需完整来源覆盖与正数总输入；缺项或总输入为 0 时不可用。", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp)
        }
    }
}

@Composable
private fun ProviderCoverageLabel(label: String, status: UsageCoverageStatus?) {
    Text(
        label,
        color = if (status == UsageCoverageStatus.PARTIAL || status == UsageCoverageStatus.UNAVAILABLE) Color(0xFFF6C76D) else MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 11.sp,
        lineHeight = 15.sp,
    )
}

internal fun formatUsageMetric(metric: UsageMetric): String {
    if (metric.quality == UsageQuality.UNAVAILABLE) return "不可用"
    val value = metric.value ?: return "不可用"
    return (if (metric.quality == UsageQuality.PARTIAL) "≥" else "") + value.toString()
}

internal fun formatCacheHitRate(usage: UsageAggregate): String {
    val cache = usage.cacheHit
    val numerator = cache.numerator ?: return "不可用"
    val denominator = cache.denominator ?: return "不可用"
    if (cache.quality != UsageQuality.COMPLETE || denominator <= 0L || numerator > denominator) return "不可用"
    val allProvidersComplete = usage.claudeCoverage.status == UsageCoverageStatus.READY &&
        usage.codexCoverage.status == UsageCoverageStatus.READY &&
        usage.claudeCoverage.completeResponses == usage.claudeCoverage.observedResponses &&
        usage.codexCoverage.completeResponses == usage.codexCoverage.observedResponses &&
        usage.completeResponses == usage.observedResponses &&
        usage.totalInput.quality == UsageQuality.COMPLETE
    if (!allProvidersComplete) return "不可用"
    return String.format(Locale.US, "%.1f%%", numerator.toDouble() * 100.0 / denominator)
}

internal fun formatObservedResponses(usage: UsageAggregate): String {
    val ready = usage.claudeCoverage.status == UsageCoverageStatus.READY &&
        usage.codexCoverage.status == UsageCoverageStatus.READY
    return (if (ready) "" else "≥") + usage.observedResponses.toString()
}

private fun responseCountQuality(usage: UsageAggregate): UsageQuality =
    if (usage.claudeCoverage.status == UsageCoverageStatus.READY && usage.codexCoverage.status == UsageCoverageStatus.READY) {
        UsageQuality.COMPLETE
    } else {
        UsageQuality.PARTIAL
    }
