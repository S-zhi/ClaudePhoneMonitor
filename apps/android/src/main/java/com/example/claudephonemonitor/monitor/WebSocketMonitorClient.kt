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
) : MonitorClient {
    private val eventFlow = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 32)
    private val connectionState = MutableStateFlow(false)
    private var socket: WebSocket? = null

    override val events: Flow<MonitorEvent> = eventFlow.asSharedFlow()
    override val isConnected = connectionState

    override fun connect() {
        if (socket != null) return
        val request = androidWebSocketRequest(endpoint)
        socket = httpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
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
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
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

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socket = null
                    connectionState.value = false
                    eventFlow.tryEmit(
                        MonitorEvent(
                            type = MonitorEventType.DISCONNECTED,
                            detail = t.message ?: "WebSocket connection failed",
                        ),
                    )
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socket = null
                    connectionState.value = false
                    eventFlow.tryEmit(
                        MonitorEvent(
                            type = MonitorEventType.DISCONNECTED,
                            detail = reason.ifBlank { "WebSocket closed" },
                        ),
                    )
                }
            },
        )
    }

    override fun disconnect() {
        socket?.close(1000, "monitor closed")
        socket = null
        connectionState.value = false
    }

    override fun send(command: MonitorCommand) {
        socket?.send(command.toWireJson())
    }
}
