package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.UsageAggregate
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageProviderCoverage
import com.example.claudephonemonitor.monitor.UsageQuality
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal const val USAGE_START_COMMAND = "./scripts/start-lan-monitor.sh --watch-usage"

internal data class UsagePresentation(
    val collectionTitle: String,
    val collectionDetail: String,
    val connectionLabel: String,
    val showSetup: Boolean,
    val freshnessLabel: String,
)

/** Collection, source coverage, quota availability and transport are separate states. */
internal fun usagePresentation(state: MonitorUiState): UsagePresentation {
    val usage = state.snapshot.usage
    val quotaSampledAt = usage?.quota?.sampledAt
    val title = when {
        usage == null -> "尚未收到 Usage 数据"
        usage.observedResponses == 0L -> "采集已启用 · 等待新响应"
        usage.claudeCoverage.status != UsageCoverageStatus.READY ||
            usage.codexCoverage.status != UsageCoverageStatus.READY -> "部分来源可用 · 已保留累计数据"
        else -> "正在累计已观测的模型响应"
    }
    return UsagePresentation(
        collectionTitle = title,
        collectionDetail = if (usage == null) {
            "在 Mac 启用采集后，等待 Claude 或 Codex 的新模型响应。"
        } else {
            "首次启用：${usage.startedAt} · 仅统计启用后的响应，不回填历史。"
        },
        connectionLabel = when {
            !state.isConnected && usage == null -> "Relay 离线 · 等待连接"
            !state.isConnected -> "Relay 离线 · 上次快照，未实时更新"
            state.snapshot.computerState == ComputerState.OFFLINE -> "Relay 已连接 · Mac 采集端离线"
            state.snapshot.computerState == ComputerState.STALE -> "Relay 已连接 · Mac 数据可能过期"
            else -> "Relay 已连接"
        },
        showSetup = usage == null,
        freshnessLabel = when {
            !state.isConnected && state.snapshot.computerState == ComputerState.OFFLINE -> "Relay 离线 · Mac 采集端离线"
            !state.isConnected -> "快照 · 未实时更新"
            state.snapshot.computerState == ComputerState.OFFLINE -> "Mac 采集端离线"
            state.snapshot.computerState == ComputerState.STALE -> "额度可能过期 · ${quotaSampledAt?.let(::formatUsageStartedAt) ?: "等待采样"}"
            quotaSampledAt != null -> "额度采样 ${formatUsageStartedAt(quotaSampledAt)}"
            state.snapshot.updatedAt.isBlank() -> "等待更新时间"
            else -> "更新 ${formatUsageStartedAt(state.snapshot.updatedAt)}"
        },
    )
}

internal fun formatUsageStartedAt(value: String, zone: ZoneId = ZoneId.systemDefault()): String =
    runCatching {
        DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.CHINA).withZone(zone).format(Instant.parse(value))
    }.getOrDefault(value)

internal fun formatProviderCoverage(name: String, coverage: UsageProviderCoverage?): String {
    if (coverage == null) return "$name · 未收到来源状态"
    val label = when (coverage.status) {
        UsageCoverageStatus.READY -> if (coverage.observedResponses == 0L) "监听中，等待响应" else "完整"
        UsageCoverageStatus.PARTIAL -> "部分（累计缺项）"
        UsageCoverageStatus.UNAVAILABLE -> "来源不可用"
    }
    return "$name · $label · 完整 ${coverage.completeResponses}/${coverage.observedResponses}"
}

internal fun usageCacheExplanation(usage: UsageAggregate?): String =
    "缓存命中 Tokens ${usage?.cachedInput?.let(::formatUsageMetric) ?: "不可用"} / 总输入 ${usage?.totalInput?.let(::formatUsageMetric) ?: "不可用"}"

internal fun formatUsageRangeLabel(usage: UsageAggregate?): String {
    if (usage == null) return "统计范围 · 等待首条响应"
    val began = formatUsageStartedAt(usage.startedAt)
    val hasPartialCoverage = usage.claudeCoverage.status != UsageCoverageStatus.READY ||
        usage.codexCoverage.status != UsageCoverageStatus.READY ||
        usage.actual.quality != UsageQuality.COMPLETE ||
        usage.newInput.quality != UsageQuality.COMPLETE ||
        usage.completeResponses < usage.observedResponses
    return if (hasPartialCoverage) {
        "已观测累计 · 部分来源\n自 $began 起"
    } else {
        "累计用量 · 自 $began 起"
    }
}

internal fun formatCollectorRuntime(startedAt: String, nowMillis: Long = System.currentTimeMillis()): String = runCatching {
    val elapsed = ((nowMillis - Instant.parse(startedAt).toEpochMilli()).coerceAtLeast(0L)) / 1000L
    val days = elapsed / 86_400L
    val hours = (elapsed % 86_400L) / 3_600L
    val minutes = (elapsed % 3_600L) / 60L
    val label = when {
        days > 0 -> "${days}天${hours}时"
        hours > 0 -> "${hours}时${minutes}分"
        else -> "${minutes}分钟"
    }
    "服务已运行 $label"
}.getOrDefault("服务时长 —")
