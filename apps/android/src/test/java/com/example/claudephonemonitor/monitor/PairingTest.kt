package com.example.claudephonemonitor.monitor

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingTest {
    private val qr = """
        {
          "version": 1,
          "relay_http_url": "http://192.168.1.3:8787",
          "relay_ws_url": "ws://192.168.1.3:8787/ws/android",
          "pairing_id": "pair-1",
          "pairing_code": "ABCD1234",
          "installation_id": "install-1"
        }
    """.trimIndent()

    @Test
    fun parsesLanQrPayload() {
        val payload = PairingPayload.parse(qr)
        assertEquals("http://192.168.1.3:8787", payload.relayHttpUrl)
        assertEquals("ws://192.168.1.3:8787/ws/android", payload.relayWsUrl)
        assertEquals("pair-1", payload.pairingId)
    }

    @Test
    fun rejectsPhoneLocalhostPayload() {
        val local = qr.replace("192.168.1.3", "127.0.0.1")
        assertThrows(IllegalArgumentException::class.java) { PairingPayload.parse(local) }
    }

    @Test
    fun normalizesLegacyPersistedBaseUrlAtWebSocketUseBoundary() {
        val previouslyStored = PairingConfig(
            relayHttpUrl = "http://192.168.1.9:8787",
            relayWsUrl = "ws://192.168.1.9:8787",
            installationId = "install-1",
            androidToken = "existing-token",
        )

        val request = androidWebSocketRequest(previouslyStored.relayWsUrl)

        assertEquals("/ws/android", request.url.encodedPath)
        assertEquals("existing-token", previouslyStored.androidToken)
    }

    @Test
    fun preservesAndroidEndpointAndMapsHttpSchemes() {
        assertEquals(
            "ws://192.168.1.9:8787/ws/android",
            normalizeAndroidWebSocketUrl("ws://192.168.1.9:8787/ws/android"),
        )
        assertEquals(
            "wss://monitor.example/ws/android",
            normalizeAndroidWebSocketUrl("https://monitor.example/ws/collector"),
        )
    }

    @Test
    fun rejectsInvalidOrUnsafeWebSocketUrls() {
        listOf(
            "not a URL",
            "ftp://192.168.1.9:8787/ws/android",
            "ws://192.168.1.9:8787/other",
            "ws://user:secret@192.168.1.9:8787/ws/android",
            "ws://192.168.1.9:8787/ws/android?token=secret",
            "ws://192.168.1.9:8787//ws/android",
        ).forEach { url ->
            assertThrows(IllegalArgumentException::class.java) {
                normalizeAndroidWebSocketUrl(url)
            }
        }
    }

    @Test
    fun successfulClaimSavesTheCanonicalQrUrlAndClaimToken() {
        val config = runBlocking {
            PairingRepository(pairingResponseClient("ws://192.168.1.9:8787/ws/collector"))
                .claim(pairingPayload("ws://192.168.1.9:8787"), "Pixel")
        }

        assertEquals("ws://192.168.1.9:8787/ws/android", config.relayWsUrl)
        assertEquals("token-from-claim", config.androidToken)
    }

    @Test
    fun claimRejectsWebSocketUrlFromDifferentOrigin() {
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                PairingRepository(pairingResponseClient("ws://192.168.1.10:8787/ws/android"))
                    .claim(pairingPayload("ws://192.168.1.9:8787"), "Pixel")
            }
        }
    }

    private fun pairingPayload(relayWsUrl: String) = PairingPayload(
        relayHttpUrl = "http://192.168.1.9:8787",
        relayWsUrl = relayWsUrl,
        pairingId = "pair-1",
        pairingCode = "ABCD1234",
        installationId = "install-1",
    )

    private fun pairingResponseClient(webSocketUrl: String): OkHttpClient {
        val body = JSONObject()
            .put("ws_url", webSocketUrl)
            .put("installation_id", "install-1")
            .put("android_token", "token-from-claim")
            .toString()
            .toResponseBody("application/json".toMediaType())

        return OkHttpClient.Builder()
            .addInterceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(body)
                    .build()
            }
            .build()
    }
}
