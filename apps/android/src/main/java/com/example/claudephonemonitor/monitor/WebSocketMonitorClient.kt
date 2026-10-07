package com.example.claudephonemonitor.monitor

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow

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
        .build(),
    private val webSocketFactory: WebSocket.Factory = httpClient,
) : MonitorClient {
    private val eventFlow = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 32)
    private val connectionState = MutableStateFlow(false)
    private val lock = Any()
    private var socket: WebSocket? = null
    private var generationCounter = 0L
    private var activeGeneration: Long? = null

    override val events: Flow<MonitorEvent> = eventFlow.asSharedFlow()
    override val isConnected = connectionState

    override fun connect() {
        val (generation, request) = synchronized(lock) {
            if (activeGeneration != null) return
            val request = androidWebSocketRequest(endpoint)
            val newGeneration = ++generationCounter
            activeGeneration = newGeneration
            newGeneration to request
        }
        val createdSocket = try {
            webSocketFactory.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        val accepted = synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) {
                                false
                            } else {
                                connectionState.value = true
                                webSocket.send(
                                    MonitorCommand.Hello(
                                        installationId = installationId,
                                        clientId = clientId,
                                        token = token,
                                        lastSequence = lastSequence,
                                    ).toWireJson(),
                                )
                                webSocket.send(
                                    MonitorCommand.Subscribe(
                                        installationId = installationId,
                                        token = token,
                                        lastSequence = lastSequence,
                                    ).toWireJson(),
                                )
                                eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.CONNECTED))
                                true
                            }
                        }
                        if (!accepted) webSocket.close(1000, "stale monitor connection")
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        synchronized(lock) {
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
                            event.sequence?.let { lastSequence = maxOf(lastSequence, it) }
                            event.snapshot?.lastSequence?.let { lastSequence = maxOf(lastSequence, it) }
                            eventFlow.tryEmit(event)
                        }
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        synchronized(lock) {
                            if (!claimSocketLocked(generation, webSocket)) return
                            terminateLocked(t.message ?: "WebSocket connection failed")
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
        } catch (failure: Throwable) {
            val failedSocket = synchronized(lock) {
                if (activeGeneration == generation) {
                    activeGeneration = null
                    connectionState.value = false
                    socket.also { socket = null }
                } else {
                    null
                }
            }
            failedSocket?.cancel()
            throw failure
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
        oldSocket?.close(1000, "monitor closed")
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
    private fun terminateLocked(detail: String) {
        activeGeneration = null
        socket = null
        connectionState.value = false
        eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.DISCONNECTED, detail = detail))
    }
}
