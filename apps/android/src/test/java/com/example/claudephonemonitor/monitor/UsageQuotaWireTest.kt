package com.example.claudephonemonitor.monitor

import com.example.claudephonemonitor.ui.formatCacheHitRate
import com.example.claudephonemonitor.ui.formatCacheHitScope
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UsageQuotaWireTest {
    @Test fun readsAndRoundTripsQuotaWindowCollectorUptimeAndCacheScope() {
        val raw = fixture().apply {
            val usage = getJSONObject("usage")
            usage.put("collector_started_at", "2026-10-08T01:00:00Z")
            usage.getJSONObject("cache_hit").apply {
                put("numerator", 75)
                put("denominator", 100)
                put("quality", "partial")
                put("providers", JSONArray(listOf("codex")))
                put("sample_responses", 1)
            }
            usage.getJSONObject("quota").apply {
                put("availability", "available")
                put("start_remaining", 91.5)
                put("current_remaining", 63.0)
                put("unit", "percent")
                put("reset_at", "2026-10-15T00:00:00Z")
                put("source", "codex_app_server")
                put("limit_id", "codex")
                put("window_minutes", 10080)
                put("window", "primary")
                put("sampled_at", "2026-10-08T01:05:00Z")
                put("start_sampled_at", "2026-10-08T01:00:00Z")
                put("start_reset_at", "2026-10-15T00:00:00Z")
            }
        }
        val snapshot = requireNotNull(MonitorEvent.fromWireJson(raw.toString())).snapshot!!
        val usage = requireNotNull(snapshot.usage)
        assertEquals(63.0, usage.quota.currentRemaining!!, 0.0)
        assertEquals("codex_app_server", usage.quota.source)
        assertEquals(10080, usage.quota.windowMinutes)
        assertEquals("2026-10-08T01:00:00Z", usage.collectorStartedAt)
        assertEquals(listOf("codex"), usage.cacheHit.providers)
        assertEquals(1L, usage.cacheHit.sampleResponses)
        assertEquals("约75%", formatCacheHitRate(usage))
        assertEquals("完整 Codex 响应 · 部分覆盖", formatCacheHitScope(usage))

        val roundTrip = requireNotNull(MonitorEvent.fromWireJson(snapshot.toJson().toString())).snapshot!!.usage!!
        assertEquals(usage.quota, roundTrip.quota)
        assertEquals(usage.cacheHit, roundTrip.cacheHit)
        assertEquals(usage.collectorStartedAt, roundTrip.collectorStartedAt)
    }

    @Test fun rejectsOutOfRangeQuotaAndInvalidCacheProviderScope() {
        val badQuota = fixture().apply {
            getJSONObject("usage").getJSONObject("quota").apply {
                put("availability", "available").put("unit", "percent").put("current_remaining", 100.1)
                put("source", "codex_app_server").put("limit_id", "codex").put("reset_at", "2026-10-15T00:00:00Z")
                put("sampled_at", "2026-10-08T01:05:00Z").put("window_minutes", 10080).put("window", "primary")
            }
        }
        assertNull(MonitorEvent.fromWireJson(badQuota.toString())!!.snapshot!!.usage)

        val badProviders = fixture().apply { getJSONObject("usage").getJSONObject("cache_hit").put("providers", JSONArray(listOf("provider-x"))) }
        assertNull(MonitorEvent.fromWireJson(badProviders.toString())!!.snapshot!!.usage)
    }


    @Test fun staleQuotaWithoutRemainingValueKeepsTheTokenLedger() {
        val raw = fixture().apply {
            getJSONObject("usage").getJSONObject("quota").apply {
                put("availability", "stale")
                put("source", "codex_app_server").put("limit_id", "codex").put("unit", "percent")
                put("reset_at", "2026-10-15T00:00:00Z").put("sampled_at", "2026-10-08T01:05:00Z")
                put("window_minutes", 10080).put("window", "primary")
            }
        }
        val usage = requireNotNull(MonitorEvent.fromWireJson(raw.toString())).snapshot!!.usage!!
        assertEquals("stale", usage.quota.availability)
        assertNull(usage.quota.currentRemaining)
        assertEquals(110L, usage.actual.value)
    }

    private fun fixture() = JSONObject(requireNotNull(javaClass.getResource("/usage-relay-snapshot.json")).readText())
}
