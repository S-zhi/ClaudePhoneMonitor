package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageProviderCoverage
import com.example.claudephonemonitor.monitor.UsageMetric
import com.example.claudephonemonitor.monitor.UsageQuality
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsagePresentationTest {
    @Test
    fun emptyCollectionExplainsHowToEnableWithoutGuessingWhyDataIsMissing() {
        val presentation = usagePresentation(MonitorUiState(isConnected = true, snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE)))
        assertEquals("尚未收到 Usage 数据", presentation.collectionTitle)
        assertEquals("Relay 已连接", presentation.connectionLabel)
        assertTrue(presentation.showSetup)
        assertTrue(presentation.collectionDetail.contains("新模型响应"))
        assertEquals("./scripts/start-lan-monitor.sh --watch-usage", USAGE_START_COMMAND)
        assertEquals("Claude · 未收到来源状态", formatProviderCoverage("Claude", null))
        assertEquals("缓存命中 Tokens 不可用 / 总输入 不可用", usageCacheExplanation(null))
    }

    @Test
    fun enabledCollectionWaitsForNewResponsesWithoutTreatingMissingQuotaAsMissingUsage() {
        val empty = snapshot().usage!!.copy(observedResponses = 0, completeResponses = 0)
        val presentation = usagePresentation(MonitorUiState(isConnected = true, snapshot = snapshot().copy(usage = empty)))
        assertEquals("采集已启用 · 等待新响应", presentation.collectionTitle)
        assertFalse(presentation.showSetup)
        assertTrue(presentation.collectionDetail.contains(empty.startedAt))
        assertTrue(presentation.collectionDetail.contains("不回填历史"))
        assertEquals("unavailable", empty.quota.availability)
        assertTrue(formatProviderCoverage("Codex", UsageProviderCoverage(UsageCoverageStatus.READY, 0, 0)).contains("等待响应"))
    }

    @Test
    fun partialEpochKeepsItsConfirmedValuesAndNamesEachSourceGap() {
        val usage = snapshot().usage!!.copy(
            actual = UsageMetric(185, UsageQuality.PARTIAL),
            claudeCoverage = UsageProviderCoverage(UsageCoverageStatus.PARTIAL, 2, 1),
        )
        val original = snapshot().copy(usage = usage)
        val presentation = usagePresentation(MonitorUiState(isConnected = true, snapshot = original))
        assertEquals("部分来源可用 · 已保留累计数据", presentation.collectionTitle)
        assertFalse(presentation.showSetup)
        assertEquals("≥185", formatUsageMetric(usage.actual))
        assertTrue(formatProviderCoverage("Claude", usage.claudeCoverage).contains("累计缺项"))
        assertTrue(formatProviderCoverage("Codex", UsageProviderCoverage(UsageCoverageStatus.UNAVAILABLE, 0, 0)).contains("来源不可用"))
    }

    @Test
    fun relayTransportAndMacFreshnessAreReportedIndependentlyWithoutDiscardingUsage() {
        val original = snapshot()
        val disconnected = MonitorUiState(isConnected = false, snapshot = original)
        assertEquals("Relay 离线 · 上次快照，未实时更新", usagePresentation(disconnected).connectionLabel)
        assertEquals(original.usage, disconnected.snapshot.usage)
        assertEquals("Relay 离线 · 等待连接", usagePresentation(MonitorUiState()).connectionLabel)
        assertEquals("Relay 已连接 · Mac 采集端离线", usagePresentation(disconnected.copy(isConnected = true, snapshot = original.copy(computerState = ComputerState.OFFLINE))).connectionLabel)
        assertEquals("Relay 已连接 · Mac 数据可能过期", usagePresentation(disconnected.copy(isConnected = true, snapshot = original.copy(computerState = ComputerState.STALE))).connectionLabel)
    }

    @Test
    fun firstEnableTimeIsLocalizedAndUnexpectedTimestampIsStillVisible() {
        assertEquals("10-07 08:00", formatUsageStartedAt("2026-10-07T00:00:00Z", ZoneId.of("Asia/Shanghai")))
        assertEquals("older-relay-time", formatUsageStartedAt("older-relay-time"))
    }


    @Test
    fun serviceRuntimeUsesCollectorProcessStartRatherThanLedgerEnableTime() {
        val start = "2026-10-08T00:00:00Z"
        val elapsed = java.time.Instant.parse(start).toEpochMilli() + 3_780_000L
        assertEquals("服务已运行 1时3分", formatCollectorRuntime(start, elapsed))
        assertEquals("服务时长 —", formatCollectorRuntime("not-a-timestamp", elapsed))
    }

    private fun snapshot(): MonitorSnapshot {
        val wire = javaClass.getResource("/usage-relay-snapshot.json")!!.readText()
        return MonitorEvent.fromWireJson(wire)!!.snapshot!!
    }
}
