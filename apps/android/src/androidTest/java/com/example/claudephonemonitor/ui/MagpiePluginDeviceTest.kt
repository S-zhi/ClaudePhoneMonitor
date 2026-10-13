package com.example.claudephonemonitor.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.MainActivity
import com.example.claudephonemonitor.monitor.PairingPayload
import com.example.claudephonemonitor.monitor.PairingRepository
import com.example.claudephonemonitor.monitor.PairingStore
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real Magpie Bun host -> paired Relay -> production MainActivity, using synthetic native files. */
@RunWith(AndroidJUnit4::class)
class MagpiePluginDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test(timeout = 240_000L)
    fun realPluginLifecycleHistoryRestartAndLivePairing() {
        val base = InstrumentationRegistry.getArguments().getString("deviceRelayUrl")?.trimEnd('/')
        assumeTrue("Pass -e deviceRelayUrl http://127.0.0.1:18889/device-test", base != null)
        val api = FixtureApi(requireNotNull(base))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName.endsWith(".magpieusbtest")) { "Refusing PairingStore access outside isolated USB app" }
        val store = PairingStore(context)
        store.clear()

        val synthetic = claim(api.get("/config"), "Magpie USB synthetic fixture")
        store.save(synthetic)
        compose.activityRule.scenario.recreate()
        val fixtureInfo = api.get("/fixture")
        val rowTag = "session-${fixtureInfo.getString("session_id")}"
        awaitUi(45_000) { compose.onNodeWithText("RELAY CONNECTED").assertIsDisplayed() }

        // Metadata-only initial discovery is history, not an active/running row.
        awaitUi(30_000) { compose.onNodeWithTag("history-toggle").assertIsDisplayed() }
        compose.onNodeWithTag("history-toggle").performClick()
        awaitUi(45_000) {
            compose.onNodeWithText("Synthetic current session", substring = true).assertIsDisplayed()
            compose.onNodeWithText("Synthetic old Codex history", substring = true).assertIsDisplayed()
        }
        compose.onNodeWithTag("history-toggle").performClick()

        api.control("start")
        awaitUi(30_000) { compose.onNodeWithTag(rowTag).assert(hasContentDescription("Working", substring = true)).assertIsDisplayed() }
        api.control("rename")
        awaitUi(30_000) { compose.onNodeWithText("Synthetic Codex title renamed", substring = true).assertIsDisplayed() }
        api.control("finish")
        awaitUi(30_000) { compose.onNodeWithTag(rowTag).assert(hasContentDescription("DONE", substring = true)).assertIsDisplayed() }

        // Missing current lifecycle evidence is unknown, never a false finish/DONE.
        api.control("start-after-unknown")
        awaitUi(30_000) { compose.onNodeWithTag(rowTag).assert(hasContentDescription("Working", substring = true)).assertIsDisplayed() }
        val completedBeforeUnknown = finishedCount(api.get("/state").getJSONArray("events"))
        api.control("unknown")
        awaitUi(30_000) {
            val snapshot = api.get("/state").getJSONObject("snapshot")
            assertEquals("unknown must remove the session from active summaries", 0, snapshot.getJSONArray("sessions").length())
            val history = snapshot.getJSONArray("history_sessions")
            assertTrue("history retains the renamed session with unknown activity", (0 until history.length()).any {
                val item = history.getJSONObject(it)
                item.optString("session_id") == fixtureInfo.getString("session_id") && item.optString("activity_status") == "unknown"
            })
            assertEquals("unknown must not publish another task_finished", completedBeforeUnknown,
                finishedCount(api.get("/state").getJSONArray("events")))
        }
        compose.onNodeWithTag("history-toggle").performClick()
        awaitUi(15_000) { compose.onNodeWithText("Synthetic Codex title renamed", substring = true).assertIsDisplayed() }
        saveScreenshot("magpie-synthetic-title-history.png")

        // Verify the host's off/on lifecycle and catch-up without replaying the terminal event.
        api.control("off")
        val tickOff = api.get("/plugin-state").getLong("tick")
        api.control("start")
        Thread.sleep(2500)
        assertEquals("off freezes the plugin tick", tickOff, api.get("/plugin-state").getLong("tick"))
        api.control("on")
        awaitUi(30_000) { compose.onNodeWithTag(rowTag).assert(hasContentDescription("Working", substring = true)).assertIsDisplayed() }

        // Restart the entire official Magpie Web process; no harness plugin-list request primes it.
        api.control("restart-web")
        awaitUi(30_000) { compose.onNodeWithTag(rowTag).assert(hasContentDescription("Working", substring = true)).assertIsDisplayed() }
        api.control("disconnect-phone")
        awaitApi(25_000) { api.get("/health").getJSONObject("relay").optInt("android_connections") > 0 }

        // Leave the isolated app paired to the second, independent real-desktop installation.
        store.save(claim(api.get("/live-config"), "Magpie USB live verification"))
        compose.activityRule.scenario.recreate()
        InstrumentationRegistry.getInstrumentation().sendStatus(2, android.os.Bundle().apply {
            putString("stream", "synthetic native Codex -> genuine Magpie Bun host -> paired Relay -> MainActivity\n")
        })
    }

    private fun claim(json: JSONObject, name: String) = runBlocking {
        PairingRepository().claim(
            PairingPayload(
                relayHttpUrl = json.getString("relay_http_url"), relayWsUrl = json.getString("relay_ws_url"),
                pairingId = json.getString("pairing_id"), pairingCode = json.getString("pairing_code"),
                installationId = json.getString("installation_id"),
            ), name,
        )
    }

    private fun finishedCount(events: JSONArray): Int = (0 until events.length()).count {
        events.getJSONObject(it).optString("type") == "task_finished"
    }

    private fun awaitUi(timeoutMs: Long, assertion: () -> Unit) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try { assertion(); return } catch (error: Throwable) { last = error; Thread.sleep(250) }
        }
        throw AssertionError("Timed out waiting for Android monitor UI", last)
    }

    private fun awaitApi(timeoutMs: Long, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (runCatching(predicate).getOrDefault(false)) return
            Thread.sleep(250)
        }
        error("Timed out waiting for Relay reconnection")
    }

    private fun saveScreenshot(name: String) {
        val bitmap = compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap()
        val output = File(requireNotNull(compose.activity.getExternalFilesDir("magpie-usb")), name)
        output.parentFile?.mkdirs()
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class FixtureApi(private val base: String) {
        fun get(path: String): JSONObject = request(path, "GET")
        fun control(operation: String): JSONObject = request("/control", "POST", JSONObject().put("operation", operation))
        private fun request(path: String, method: String, body: JSONObject? = null): JSONObject {
            val connection = URL("$base$path").openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 5000
            connection.readTimeout = 10_000
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream).bufferedReader().use { it.readText() }
            check(code in 200..299) { "Fixture API HTTP $code: $text" }
            return JSONObject(text)
        }
    }
}
