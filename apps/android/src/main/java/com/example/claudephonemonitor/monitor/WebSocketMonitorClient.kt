package com.example.claudephonemonitor.monitor

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch

internal fun androidWebSocketRequest(endpoint: String): Request =
    Request.Builder().url(normalizeAndroidWebSocketUrl(endpoint)).build()

class WebSocketMonitorClient(
    private val endpoint: String,
    private val installationId: String,
    private val token: String,
    private val clientId: String = "phone-monitor-android",
    private var lastSequence: Long = 0L,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build(),
    private val webSocketFactory: WebSocket.Factory = httpClient,
    private val reconnectScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) : MonitorClient {
    private val eventFlow = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 32)
    private val connectionState = MutableStateFlow(false)
    private val lock = Any()
    private var socket: WebSocket? = null
    private var generationCounter = 0L
    private var activeGeneration: Long? = null
    private var connectionRequested = false
    private var reconnectJob: Job? = null
    private var reconnectGeneration = 0L
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

    override val events: Flow<MonitorEvent> = eventFlow.asSharedFlow()
    override val isConnected = connectionState

    override fun connect() {
        val (generation, request) = synchronized(lock) {
            if (activeGeneration != null) return
            val nextConnection = prepareConnectionLocked()
            connectionRequested = true
            cancelReconnectLocked()
            reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
            nextConnection
        }
        openConnection(generation, request)
    }

    private fun openConnection(generation: Long, request: Request) {
        val createdSocket = try {
            webSocketFactory.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        val accepted = synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) {
                                false
                            } else {
                                val helloSent = webSocket.send(
                                    MonitorCommand.Hello(
                                        installationId = installationId,
                                        clientId = clientId,
                                        token = token,
                                        lastSequence = lastSequence,
                                    ).toWireJson(),
                                )
                                val subscribed = helloSent && webSocket.send(
                                    MonitorCommand.Subscribe(
                                        installationId = installationId,
                                        token = token,
                                        lastSequence = lastSequence,
                                    ).toWireJson(),
                                )
                                if (subscribed) {
                                    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
                                    connectionState.value = true
                                    eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.CONNECTED))
                                    true
                                } else {
                                    terminateLocked("WebSocket subscription could not be sent")
                                    false
                                }
                            }
                        }
                        if (!accepted && !webSocket.close(1000, "monitor connection unavailable")) {
                            webSocket.cancel()
                        }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val authenticationRejected = synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) return
                            val event = MonitorEvent.fromWireJson(text)
                            if (event == null) {
                                eventFlow.tryEmit(
                                    MonitorEvent(
                                        type = MonitorEventType.EVENT,
                                        detail = "Unrecognized monitor message",
                                    ),
                                )
                                return
                            }
                            if (event.type == MonitorEventType.UNKNOWN && isAuthenticationRejection(text)) {
                                terminateLocked(
                                    event.detail.ifBlank { "Relay authentication rejected" },
                                    retry = false,
                                )
                                true
                            } else {
                                event.sequence?.let { lastSequence = maxOf(lastSequence, it) }
                                event.snapshot?.lastSequence?.let { lastSequence = maxOf(lastSequence, it) }
                                eventFlow.tryEmit(event)
                                false
                            }
                        }
                        if (authenticationRejected && !webSocket.close(1000, "monitor credentials rejected")) {
                            webSocket.cancel()
                        }
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) return
                            terminateLocked(
                                t.message ?: "WebSocket connection failed",
                                retry = response?.code != 401 && response?.code != 403,
                            )
                        }
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        val accepted = synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) {
                                false
                            } else {
                                terminateLocked(reason.ifBlank { "WebSocket closing" })
                                true
                            }
                        }
                        // A peer close frame already ends the usable connection.
                        // Reply with a legal code even when the peer sent an empty frame (1005).
                        if (accepted && !webSocket.close(1000, null)) webSocket.cancel()
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) return
                            terminateLocked(reason.ifBlank { "WebSocket closed" })
                        }
                    }
                },
            )
        } catch (failure: Exception) {
            val failedSocket = synchronized(lock) {
                if (activeGeneration == generation) {
                    val failed = socket
                    terminateLocked(failure.message ?: "WebSocket connection failed")
                    failed
                } else {
                    null
                }
            }
            failedSocket?.cancel()
            return
        }

        val stale = synchronized(lock) {
            if (activeGeneration != generation) {
                true
            } else if (socket == null) {
                socket = createdSocket
                false
            } else {
                socket !== createdSocket
            }
        }
        if (stale) createdSocket.cancel()
    }

    override fun disconnect() {
        val oldSocket = synchronized(lock) {
            connectionRequested = false
            cancelReconnectLocked()
            reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
            if (activeGeneration == null) {
                connectionState.value = false
                null
            } else {
                activeGeneration = null
                val old = socket
                socket = null
                connectionState.value = false
                eventFlow.tryEmit(
                    MonitorEvent(type = MonitorEventType.DISCONNECTED, detail = "monitor closed"),
                )
                old
            }
        }
        if (oldSocket != null && !oldSocket.close(1000, "monitor closed")) oldSocket.cancel()
    }

    override fun send(command: MonitorCommand) {
        synchronized(lock) {
            if (activeGeneration != null) socket?.send(command.toWireJson())
        }
    }

    /** Caller holds [lock]. The first callback may arrive before newWebSocket returns. */
    private fun claimSocketLocked(generation: Long, callbackSocket: WebSocket): Boolean {
        if (activeGeneration != generation) return false
        val currentSocket = socket
        if (currentSocket == null) {
            socket = callbackSocket
            return true
        }
        return currentSocket === callbackSocket
    }

    /** Caller holds [lock]. */
    private fun terminateLocked(detail: String, retry: Boolean = true) {
        activeGeneration = null
        socket = null
        connectionState.value = false
        if (!retry) {
            connectionRequested = false
            cancelReconnectLocked()
        }
        eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.DISCONNECTED, detail = detail))
        scheduleReconnectLocked()
    }

    /** Caller holds [lock]. Reserve the generation before callbacks can arrive. */
    private fun prepareConnectionLocked(): Pair<Long, Request> {
        val request = androidWebSocketRequest(endpoint)
        val generation = ++generationCounter
        activeGeneration = generation
        return generation to request
    }

    /** Caller holds [lock]. Invalidate even a retry that has already left its delay. */
    private fun cancelReconnectLocked() {
        reconnectGeneration += 1
        reconnectJob?.cancel()
        reconnectJob = null
    }

    /** Caller holds [lock]. Only one retry can reserve the next socket generation. */
    private fun scheduleReconnectLocked() {
        if (!connectionRequested || reconnectJob != null) return
        val retryGeneration = ++reconnectGeneration
        val delayMs = reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
        reconnectJob = reconnectScope.launch(start = CoroutineStart.LAZY) {
            delay(delayMs)
            val (generation, request) = synchronized(lock) {
                if (!connectionRequested || reconnectGeneration != retryGeneration || activeGeneration != null) {
                    return@launch
                }
                reconnectJob = null
                prepareConnectionLocked()
            }
            openConnection(generation, request)
        }
        reconnectJob?.start()
    }

    private fun isAuthenticationRejection(text: String): Boolean = runCatching {
        val message = JSONObject(text)
        message.optString("type") == "error" && message.optString("code") in setOf("unauthorized", "forbidden")
    }.getOrDefault(false)

    private companion object {
        const val INITIAL_RECONNECT_DELAY_MS = 1_000L
        const val MAX_RECONNECT_DELAY_MS = 30_000L
    }
}
