package com.example.claudephonemonitor.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.UsageAggregate
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageMetric
import com.example.claudephonemonitor.monitor.UsageQuality
import java.util.Locale

@Composable
internal fun UsageMonitorScreen(
    uiState: MonitorUiState,
    onReturnToStatus: () -> Unit,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val usage = uiState.snapshot.usage
    Column(
        modifier = modifier.padding(horizontal = if (compact) 10.dp else 18.dp, vertical = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
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
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "USAGE",
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = if (compact) 16.sp else 19.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 1.5.sp,
                )
                Text(
                    text = if (usage == null) "Usage 尚未启用或当前不可用" else "累计自 ${usage.startedAt}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = if (compact) 9.sp else 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = if (uiState.isConnected) "Relay 已连接" else "离线 · 显示上次收到的服务端快照",
                color = if (uiState.isConnected) Color(0xFF8DE6A8) else Color(0xFFF6C76D),
                fontSize = if (compact) 9.sp else 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Column(
            modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().height(if (compact) 150.dp else 210.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                UsageQuotaDial(
                    modifier = Modifier.weight(if (compact) 0.36f else 0.32f).fillMaxHeight(),
                    compact = compact,
                )
                UsageMetrics(
                    usage = usage,
                    modifier = Modifier.weight(if (compact) 0.64f else 0.68f).fillMaxHeight(),
                    compact = compact,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth().height(if (compact) 92.dp else 128.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                UsageCoverageAndCache(
                    usage = usage,
                    modifier = Modifier.weight(0.58f).fillMaxHeight(),
                    compact = compact,
                )
                Column(
                    modifier = Modifier.weight(0.42f).fillMaxHeight(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        "Clawd 闲暇中",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = if (compact) 9.sp else 11.sp,
                    )
                    ClawdProceduralView(
                        state = PetState.FINISH,
                        activity = ActivityVariation.CELEBRATE,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun UsageQuotaDial(modifier: Modifier = Modifier, compact: Boolean) {
    Column(
        modifier = modifier.padding(end = if (compact) 6.dp else 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(if (compact) 112.dp else 164.dp)
                .border(2.dp, Color(0xFF6D4A3C), CircleShape)
                .padding(if (compact) 10.dp else 16.dp)
                .border(1.dp, Color(0xFF49372F), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("剩余额度", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = if (compact) 9.sp else 11.sp)
                Text("不可用", color = MaterialTheme.colorScheme.primary, fontSize = if (compact) 16.sp else 21.sp, fontWeight = FontWeight.Bold)
                Text("无可信额度来源", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp)
            }
        }
        Spacer(Modifier.height(4.dp))
        Text("启动时 —   当前 —", color = MaterialTheme.colorScheme.onSurface, fontSize = if (compact) 9.sp else 10.sp)
    }
}

@Composable
private fun UsageMetrics(usage: UsageAggregate?, modifier: Modifier = Modifier, compact: Boolean) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 8.dp)) {
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 8.dp)) {
            UsageMetricCard("新输入 Tokens", usage?.newInput?.let(::formatUsageMetric) ?: "不可用", usage?.newInput?.quality, compact, Modifier.weight(1f).fillMaxHeight())
            UsageMetricCard("实际消耗 Tokens", usage?.actual?.let(::formatUsageMetric) ?: "不可用", usage?.actual?.quality, compact, Modifier.weight(1f).fillMaxHeight())
        }
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 8.dp)) {
            UsageMetricCard("缓存命中率", usage?.let(::formatCacheHitRate) ?: "不可用", usage?.cacheHit?.quality, compact, Modifier.weight(1f).fillMaxHeight())
            UsageMetricCard("总请求数", usage?.let(::formatObservedResponses) ?: "不可用", usage?.let(::responseCountQuality), compact, Modifier.weight(1f).fillMaxHeight())
        }
    }
}

@Composable
private fun UsageMetricCard(
    label: String,
    value: String,
    quality: UsageQuality?,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xFF28221F)).padding(horizontal = if (compact) 7.dp else 12.dp, vertical = if (compact) 5.dp else 9.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = if (compact) 9.sp else 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, color = MaterialTheme.colorScheme.onSurface, fontFamily = FontFamily.Monospace, fontSize = if (compact) 14.sp else 18.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val qualityLabel = when (quality) {
            UsageQuality.PARTIAL -> "部分数据"
            UsageQuality.UNAVAILABLE, null -> "不可用"
            UsageQuality.COMPLETE -> "完整汇总"
        }
        Text(qualityLabel, color = if (quality == UsageQuality.PARTIAL) Color(0xFFF6C76D) else MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp, maxLines = 1)
    }
}

@Composable
private fun UsageCoverageAndCache(usage: UsageAggregate?, modifier: Modifier = Modifier, compact: Boolean) {
    Column(
        modifier = modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xFF28221F)).padding(horizontal = if (compact) 8.dp else 12.dp, vertical = if (compact) 5.dp else 8.dp),
        verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 4.dp),
    ) {
        Text(
            text = "缓存命中 Tokens：${usage?.cachedInput?.let(::formatUsageMetric) ?: "不可用"} / 总输入 ${usage?.totalInput?.let(::formatUsageMetric) ?: "不可用"}",
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = if (compact) 9.sp else 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            "缓存读取量单独列示，不计入实际消耗；总请求数为已观测模型响应，内部重试不可见。",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 9.sp,
            maxLines = if (compact) 2 else 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (usage == null) {
            Text("Claude 与 Codex 来源覆盖：不可用", color = Color(0xFFF6C76D), fontSize = 9.sp)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 14.dp)) {
                ProviderCoverageLabel("Claude", usage.claudeCoverage.status, usage.claudeCoverage.completeResponses, usage.claudeCoverage.observedResponses)
                ProviderCoverageLabel("Codex", usage.codexCoverage.status, usage.codexCoverage.completeResponses, usage.codexCoverage.observedResponses)
            }
        }
    }
}

@Composable
private fun ProviderCoverageLabel(
    name: String,
    status: UsageCoverageStatus,
    complete: Long,
    observed: Long,
) {
    val label = when (status) {
        UsageCoverageStatus.READY -> "完整"
        UsageCoverageStatus.PARTIAL -> "部分"
        UsageCoverageStatus.UNAVAILABLE -> "不可用"
    }
    Text("$name $label · $complete/$observed", color = if (status == UsageCoverageStatus.PARTIAL) Color(0xFFF6C76D) else MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp, maxLines = 1)
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
