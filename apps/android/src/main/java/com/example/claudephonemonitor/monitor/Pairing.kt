package com.example.claudephonemonitor.monitor

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.net.URISyntaxException
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.Locale
import java.util.concurrent.CancellationException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Data encoded in the short-lived QR code. It never contains a long-lived token. */
data class PairingPayload(
    val relayHttpUrl: String,
    val relayWsUrl: String,
    val pairingId: String,
    val pairingCode: String,
    val installationId: String,
) {
    companion object {
        fun parse(raw: String): PairingPayload {
            val json = JSONObject(raw)
            require(json.optInt("version", 0) == 1) { "Unsupported pairing version" }
            val http = json.getString("relay_http_url").trimEnd('/')
            val ws = normalizeAndroidWebSocketUrl(json.getString("relay_ws_url"))
            require(http.startsWith("http://") || http.startsWith("https://")) { "Invalid Relay HTTP URL" }
            require(!http.contains("127.0.0.1") && !http.contains("localhost")) {
                "QR must contain the Mac LAN address, not localhost"
            }
            return PairingPayload(
                relayHttpUrl = http,
                relayWsUrl = ws,
                pairingId = json.getString("pairing_id"),
                pairingCode = json.getString("pairing_code"),
                installationId = json.getString("installation_id"),
            )
        }
    }
}

data class PairingConfig(
    val relayHttpUrl: String,
    val relayWsUrl: String,
    val installationId: String,
    val androidToken: String,
)

/**
 * Converts configured Relay URLs into the only WebSocket route used by the Android monitor.
 * This intentionally accepts only known Relay path forms and never forwards URL credentials or
 * query parameters (which could expose pairing or authentication tokens).
 */
internal fun normalizeAndroidWebSocketUrl(value: String): String {
    require(value.isNotBlank() && value == value.trim()) { "Invalid Relay WebSocket URL" }
    val uri = try {
        URI(value)
    } catch (error: URISyntaxException) {
        throw IllegalArgumentException("Invalid Relay WebSocket URL", error)
    }
    require(uri.isAbsolute && !uri.isOpaque) { "Invalid Relay WebSocket URL" }

    val scheme = when (uri.scheme?.lowercase(Locale.ROOT)) {
        "ws", "http" -> "ws"
        "wss", "https" -> "wss"
        else -> throw IllegalArgumentException("Invalid Relay WebSocket URL scheme")
    }
    require(uri.rawUserInfo == null) { "Relay WebSocket URL must not contain credentials" }
    require(uri.rawQuery == null) { "Relay WebSocket URL must not contain a query" }
    require(uri.rawFragment == null) { "Relay WebSocket URL must not contain a fragment" }
    require(uri.port == -1 || uri.port in 1..65535) { "Invalid Relay WebSocket URL port" }
    require(uri.rawAuthority?.endsWith(":") != true) { "Invalid Relay WebSocket URL port" }
    val host = uri.host ?: throw IllegalArgumentException("Invalid Relay WebSocket URL host")

    val path = uri.rawPath.orEmpty()
    require(
        path in setOf(
            "",
            "/",
            "/ws",
            "/ws/",
            "/ws/collector",
            "/ws/collector/",
            "/ws/android",
            "/ws/android/",
        ),
    ) { "Unsupported Relay WebSocket URL path" }

    return try {
        URI(scheme, null, host.lowercase(Locale.ROOT), uri.port, "/ws/android", null, null)
            .toASCIIString()
    } catch (error: URISyntaxException) {
        throw IllegalArgumentException("Invalid Relay WebSocket URL", error)
    }
}

/** Ensures the claim endpoint did not return a WebSocket URL for a different Relay origin. */
internal fun requireSameAndroidWebSocketOrigin(qrUrl: String, claimUrl: String) {
    val qrOrigin = androidWebSocketOrigin(qrUrl)
    val claimOrigin = androidWebSocketOrigin(claimUrl)
    require(qrOrigin == claimOrigin) { "Pairing Relay WebSocket URL origin mismatch" }
}

private data class AndroidWebSocketOrigin(
    val scheme: String,
    val host: String,
    val port: Int,
)

private fun androidWebSocketOrigin(value: String): AndroidWebSocketOrigin {
    val uri = URI(normalizeAndroidWebSocketUrl(value))
    val scheme = uri.scheme.lowercase(Locale.ROOT)
    val defaultPort = if (scheme == "ws") 80 else 443
    return AndroidWebSocketOrigin(
        scheme = scheme,
        host = uri.host.lowercase(Locale.ROOT),
        port = if (uri.port == -1) defaultPort else uri.port,
    )
}

class PairingStore(context: Context) {
    private val preferences = context.getSharedPreferences("real_pairing", Context.MODE_PRIVATE)
    private val keyAlias = "claude-phone-monitor-pairing"

    fun load(): PairingConfig? {
        val encoded = preferences.getString("payload", null) ?: return null
        return runCatching { decode(encoded) }.getOrNull()
    }

    fun save(config: PairingConfig) {
        preferences.edit().putString("payload", encode(config)).apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(keyAlias, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encode(config: PairingConfig): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val plain = JSONObject().apply {
            put("relay_http_url", config.relayHttpUrl)
            put("relay_ws_url", config.relayWsUrl)
            put("installation_id", config.installationId)
            put("android_token", config.androidToken)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val combined = cipher.iv + cipher.doFinal(plain)
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    private fun decode(encoded: String): PairingConfig {
        val combined = Base64.decode(encoded, Base64.NO_WRAP)
        require(combined.size > 12) { "Invalid pairing storage" }
        val iv = combined.copyOfRange(0, 12)
        val encrypted = combined.copyOfRange(12, combined.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        val json = JSONObject(String(cipher.doFinal(encrypted), StandardCharsets.UTF_8))
        return PairingConfig(
            relayHttpUrl = json.getString("relay_http_url"),
            relayWsUrl = json.getString("relay_ws_url"),
            installationId = json.getString("installation_id"),
            androidToken = json.getString("android_token"),
        )
    }
}

class PairingRepository(
    private val client: OkHttpClient = OkHttpClient(),
) {
    suspend fun claim(payload: PairingPayload, deviceName: String): PairingConfig = withContext(Dispatchers.IO) {
        try {
            val qrAndroidWebSocketUrl = normalizeAndroidWebSocketUrl(payload.relayWsUrl)
            val body = JSONObject().apply {
                put("code", payload.pairingCode)
                put("device_name", deviceName)
            }.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${payload.relayHttpUrl}/v1/pairing/${payload.pairingId}/claim")
                .post(body)
                .build()
            client.newCall(request).execute().use { response ->
                val responseBody = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val invalidCode = response.code == 400 && runCatching {
                        JSONObject(responseBody).optString("error") == "invalid_pairing"
                    }.getOrDefault(false)
                    if (invalidCode) throw PairingClaimException(resolveInvalidPairingMessage(payload))
                    throw PairingClaimException("配对请求未成功，请确认手机与 Mac 连接后重试。")
                }

                val config = runCatching {
                    val json = JSONObject(responseBody)
                    val installationId = json.getString("installation_id")
                    require(installationId == payload.installationId)
                    val claimWebSocketUrl = json.getString("ws_url")
                    requireSameAndroidWebSocketOrigin(qrAndroidWebSocketUrl, claimWebSocketUrl)
                    PairingConfig(
                        relayHttpUrl = payload.relayHttpUrl,
                        relayWsUrl = qrAndroidWebSocketUrl,
                        installationId = installationId,
                        androidToken = json.getString("android_token").takeIf(String::isNotBlank)
                            ?: throw IllegalArgumentException(),
                    )
                }.getOrElse {
                    throw PairingClaimException("配对响应与当前二维码不匹配，请重新扫描当前二维码。")
                }
                config
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: PairingClaimException) {
            throw error
        } catch (_: Exception) {
            throw PairingClaimException("无法连接配对服务，请检查网络后重试。")
        }
    }

    private fun resolveInvalidPairingMessage(payload: PairingPayload): String {
        val refreshHint = "请在 Mac 端运行 ./scripts/start-lan-monitor.sh --watch-codex --watch-usage --pair 刷新二维码后重试。"
        return try {
            val request = Request.Builder()
                .url("${payload.relayHttpUrl}/v1/pairing/${payload.pairingId}")
                .get()
                .build()
            client.newCall(request).execute().use { response ->
                if (response.code == 404) {
                    return "当前 Relay 不认识此配对码，可能已更换或重启。$refreshHint"
                }
                if (!response.isSuccessful) return "暂时无法确认配对码状态，请检查网络后重试。"
                val status = runCatching {
                    JSONObject(response.body?.string().orEmpty()).optString("status")
                }.getOrDefault("")
                when (status) {
                    "claimed" -> "此配对码已使用。$refreshHint"
                    "expired" -> "此配对码已过期。$refreshHint"
                    "pending" -> "配对验证码不匹配，请确认扫描的是当前二维码。"
                    else -> "暂时无法确认配对码状态，请检查网络后重试。"
                }
            }
        } catch (_: Exception) {
            "暂时无法确认配对码状态，请检查网络后重试。"
        }
    }
}

class PairingClaimException(message: String) : IllegalArgumentException(message)
