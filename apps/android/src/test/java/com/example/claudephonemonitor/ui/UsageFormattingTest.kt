package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.UsageAggregate
import com.example.claudephonemonitor.monitor.UsageCacheHit
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageMetric
import com.example.claudephonemonitor.monitor.UsageProviderCoverage
import com.example.claudephonemonitor.monitor.UsageQuality
import com.example.claudephonemonitor.monitor.UsageQuota
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageFormattingTest {
    @Test
    fun partialMetricsAreLowerBoundsAndUnavailableMetricsNeverLookLikeZero() {
        assertEquals("≥140", formatUsageMetric(UsageMetric(140, UsageQuality.PARTIAL)))
        assertEquals("≥30,982,482", formatUsageMetric(UsageMetric(30_982_482, UsageQuality.PARTIAL)))
        assertEquals("0", formatUsageMetric(UsageMetric(0, UsageQuality.COMPLETE)))
        assertEquals("不可用", formatUsageMetric(UsageMetric(null, UsageQuality.UNAVAILABLE)))
    }

    @Test
    fun cacheRateRequiresCompleteCoverageAndPositiveDenominator() {
        val complete = usage(
            cacheHit = UsageCacheHit(35, 155, UsageQuality.COMPLETE),
            claude = coverage(UsageCoverageStatus.READY, 2, 2),
            codex = coverage(UsageCoverageStatus.READY, 1, 1),
            completeResponses = 3,
            observedResponses = 3,
            totalInput = UsageMetric(155, UsageQuality.COMPLETE),
        )
        assertEquals("22.6%", formatCacheHitRate(complete))

        val partial = complete.copy(
            cacheHit = UsageCacheHit(35, 155, UsageQuality.PARTIAL),
            claudeCoverage = coverage(UsageCoverageStatus.PARTIAL, 1, 0),
            completeResponses = 2,
        )
        assertEquals("不可用", formatCacheHitRate(partial))

        val zeroDenominator = complete.copy(cacheHit = UsageCacheHit(0, 0, UsageQuality.COMPLETE))
        assertEquals("不可用", formatCacheHitRate(zeroDenominator))
    }

    @Test
    fun observedResponsesAreLowerBoundsWhenEitherProviderCoverageIsPartial() {
        val partial = usage(
            cacheHit = UsageCacheHit(null, null, UsageQuality.UNAVAILABLE),
            claude = coverage(UsageCoverageStatus.PARTIAL, 2, 1),
            codex = coverage(UsageCoverageStatus.READY, 3, 3),
            completeResponses = 4,
            observedResponses = 5,
        )
        assertEquals("≥5", formatObservedResponses(partial))

        val ready = partial.copy(claudeCoverage = coverage(UsageCoverageStatus.READY, 2, 2))
        assertEquals("5", formatObservedResponses(ready))
        assertEquals("6,805", formatObservedResponses(ready.copy(observedResponses = 6_805)))
    }


    @Test
    fun quotaDialOnlyShowsAValidRemainingFractionFromAvailableQuota() {
        val base = usage(
            cacheHit = UsageCacheHit(null, null, UsageQuality.UNAVAILABLE),
            claude = coverage(UsageCoverageStatus.READY, 0, 0),
            codex = coverage(UsageCoverageStatus.READY, 0, 0),
            completeResponses = 0,
            observedResponses = 0,
        )
        assertEquals(null, quotaRemainingFraction(base))
        assertEquals(0.63f, quotaRemainingFraction(base.copy(quota = UsageQuota(100.0, 63.0, "percent", null, "available"))))
        assertEquals(null, quotaRemainingFraction(base.copy(quota = UsageQuota(100.0, 101.0, "percent", null, "available"))))
        assertEquals(0.0f, quotaRemainingFraction(base.copy(quota = UsageQuota(0.0, 0.0, "percent", null, "available"))))
        assertEquals(0.63f, quotaRemainingFraction(base.copy(quota = UsageQuota(100.0, 63.0, "percent", null, "stale"))))
    }


    @Test
    fun partialCacheRateNeedsAnExplicitValidProviderScope() {
        val base = usage(
            cacheHit = UsageCacheHit(75, 100, UsageQuality.PARTIAL),
            claude = coverage(UsageCoverageStatus.PARTIAL, 2, 1),
            codex = coverage(UsageCoverageStatus.READY, 3, 3),
            completeResponses = 4,
            observedResponses = 5,
        )
        assertEquals("不可用", formatCacheHitRate(base))
        val scoped = base.copy(cacheHit = base.cacheHit.copy(providers = listOf("codex"), sampleResponses = 3))
        assertEquals("约75%", formatCacheHitRate(scoped))
        assertEquals("完整 Codex 响应 · 部分覆盖", formatCacheHitScope(scoped))
        assertEquals("75.0%", formatCacheHitRate(base.copy(cacheHit = UsageCacheHit(75, 100, UsageQuality.COMPLETE, listOf("codex")))))
    }


    @Test
    fun startMarkerRequiresTheSameQuotaResetWindow() {
        val base = usage(
            cacheHit = UsageCacheHit(null, null, UsageQuality.UNAVAILABLE),
            claude = coverage(UsageCoverageStatus.READY, 0, 0),
            codex = coverage(UsageCoverageStatus.READY, 0, 0),
            completeResponses = 0,
            observedResponses = 0,
        )
        val quota = UsageQuota(
            startRemaining = 52.5,
            currentRemaining = 63.0,
            unit = "percent",
            resetAt = "2026-10-15T00:00:00Z",
            availability = "available",
            window = "primary",
            startSampledAt = "2026-10-08T01:00:00Z",
            startResetAt = "2026-10-15T00:00:00Z",
        )
        val aligned = base.copy(quota = quota)
        assertEquals(0.63f, quotaRemainingFraction(aligned))
        assertEquals(0.525f, quotaStartFraction(aligned))
        assertEquals(null, quotaStartFraction(aligned.copy(quota = quota.copy(startResetAt = "2026-10-08T00:00:00Z"))))
        assertEquals(null, quotaStartFraction(aligned.copy(quota = quota.copy(window = null))))
    }

    private fun usage(
        cacheHit: UsageCacheHit,
        claude: UsageProviderCoverage,
        codex: UsageProviderCoverage,
        completeResponses: Long,
        observedResponses: Long,
        totalInput: UsageMetric = UsageMetric(155, UsageQuality.COMPLETE),
    ) = UsageAggregate(
        epochId = "epoch-fixture",
        startedAt = "2026-10-07T00:00:00Z",
        revision = 1,
        observedResponses = observedResponses,
        completeResponses = completeResponses,
        claudeCoverage = claude,
        codexCoverage = codex,
        newInput = UsageMetric(120, UsageQuality.COMPLETE),
        cachedInput = UsageMetric(35, UsageQuality.COMPLETE),
        output = UsageMetric(65, UsageQuality.COMPLETE),
        actual = UsageMetric(185, UsageQuality.COMPLETE),
        totalInput = totalInput,
        cacheHit = cacheHit,
        quota = UsageQuota(null, null, null, null, "unavailable"),
    )

    private fun coverage(status: UsageCoverageStatus, observed: Long, complete: Long) =
        UsageProviderCoverage(status, observed, complete)
}
