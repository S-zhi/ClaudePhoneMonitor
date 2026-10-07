package com.example.claudephonemonitor.monitor

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.flow.collect
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSocketMonitorClientTest {
    @Test
    fun callbacksFromReplacedSocketCannotChangeCurrentConnectionOrCursor() = runBlocking {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory)
        val events = mutableListOf<MonitorEvent>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }

        client.connect()
        val socketA = factory.connections[0].socket
        client.disconnect()
        client.connect()
        val socketB = factory.connections[1].socket

        factory.open(1)
        factory.message(1, """{"type":"snapshot","snapshot":{"last_sequence":10}}""")
        yield()
        assertTrue(client.isConnected.value)
        client.send(MonitorCommand.Subscribe("install-1", "token", 10L))
        val currentEvents = events.toList()

        factory.closing(0, "late closing")
        factory.closed(0, "late close")
        factory.failure(0, "late failure")
        factory.message(0, """{"type":"event","event_type":"task_started","sequence":99}""")
        factory.open(0)
        yield()

        assertTrue(client.isConnected.value)
        assertEquals(currentEvents, events)
        assertTrue(socketA.sentTexts.isEmpty())
        assertTrue(socketA.closeCalls >= 2)
        assertTrue(socketB.sentTexts.any {
            JSONObject(it).optString("type") == "subscribe" &&
                JSONObject(it).optLong("last_sequence") == 10L
        })
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })
        assertEquals(1, events.count { it.type == MonitorEventType.CONNECTED })
        assertEquals(1, events.count { it.type == MonitorEventType.SNAPSHOT })

        client.disconnect()
        client.connect()
        val socketC = factory.connections[2].socket
        factory.open(2)
        yield()
        val hello = socketC.sentTexts.map(::JSONObject)
            .first { it.optString("type") == "hello" }
        assertEquals(10L, hello.optLong("last_sequence"))
        assertTrue(client.isConnected.value)

        collector.cancelAndJoin()
    }

    @Test
    fun relayClosingDisconnectsImmediatelyAndManualReconnectPreservesCursor() = runBlocking {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory)
        val events = mutableListOf<MonitorEvent>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.open(0)
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":12}}""")
        yield()

        // A peer close frame arrives before OkHttp can deliver onClosed.
        factory.closing(0, "relay restarting", 1001)
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)
        assertEquals(1, factory.connections.size)
        yield()
        assertEquals("relay restarting", events.last().detail)
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })

        factory.closed(0, "relay restarting")
        factory.failure(0, "late failure")
        factory.message(0, """{"type":"event","event_type":"task_started","sequence":99}""")
        yield()
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })

        client.connect()
        factory.open(1)
        factory.closing(0, "late closing")
        factory.open(0)
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":99}}""")
        yield()
        assertTrue(client.isConnected.value)
        val hello = factory.connections[1].socket.sentTexts.map(::JSONObject)
            .first { it.optString("type") == "hello" }
        assertEquals(12L, hello.optLong("last_sequence"))
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })
        collector.cancelAndJoin()
    }

    @Test
    fun emptyPeerCloseUsesLegalAcknowledgementCodeAndFallbackDetail() = runBlocking {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory)
        val events = mutableListOf<MonitorEvent>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.open(0)
        // 1005 represents an empty received close frame; it cannot be sent back.
        factory.closing(0, "", 1005)
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)
        yield()
        assertEquals("WebSocket closing", events.last().detail)
        collector.cancelAndJoin()
    }

    @Test
    fun synchronousPeerCloseBeforeFactoryReturnsDoesNotBlockManualReconnect() {
        val factory = FakeWebSocketFactory { index, socket, listener ->
            listener.onOpen(socket, response(socket.request()))
            if (index == 0) listener.onClosing(socket, 1001, "relay restarting")
        }
        val client = newClient(factory)

        client.connect()
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)
        assertTrue(factory.connections[0].socket.isCancelled)

        client.connect()
        assertEquals(2, factory.connections.size)
        assertTrue(client.isConnected.value)
    }

    @Test
    fun synchronousOpenKeepsGenerationPublishedUntilFactoryReturns() {
        lateinit var client: WebSocketMonitorClient
        val factory = FakeWebSocketFactory { index, socket, listener ->
            listener.onOpen(socket, response(socket.request()))
            if (index == 0) {
                client.disconnect()
                client.connect()
            }
        }
        client = newClient(factory)

        client.connect()

        assertEquals(2, factory.connections.size)
        assertTrue(factory.connections[0].socket.isCancelled)
        assertTrue(factory.connections[0].socket.closeCalls > 0)
        assertTrue(factory.connections[1].socket.sentTexts.any {
            JSONObject(it).optString("type") == "hello"
        })
        assertTrue(client.isConnected.value)
        client.connect()
        assertEquals(2, factory.connections.size)
    }

    private fun newClient(factory: WebSocket.Factory): WebSocketMonitorClient =
        WebSocketMonitorClient(
            endpoint = "ws://example.test/ws/android",
            installationId = "install-1",
            token = "token",
            webSocketFactory = factory,
        )

    private class FakeWebSocketFactory(
        private val onCreated: ((Int, FakeWebSocket, WebSocketListener) -> Unit)? = null,
    ) : WebSocket.Factory {
        val connections = mutableListOf<Connection>()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
            val socket = FakeWebSocket(request)
            connections += Connection(socket, listener)
            onCreated?.invoke(connections.lastIndex, socket, listener)
            return socket
        }

        fun open(index: Int) {
            val connection = connections[index]
            connection.listener.onOpen(connection.socket, response(connection.socket.request()))
        }

        fun message(index: Int, text: String) {
            val connection = connections[index]
            connection.listener.onMessage(connection.socket, text)
        }

        fun closed(index: Int, reason: String) {
            val connection = connections[index]
            connection.listener.onClosed(connection.socket, 1000, reason)
        }

        fun closing(index: Int, reason: String, code: Int = 1000) {
            val connection = connections[index]
            connection.listener.onClosing(connection.socket, code, reason)
        }

        fun failure(index: Int, detail: String) {
            val connection = connections[index]
            connection.listener.onFailure(connection.socket, IllegalStateException(detail), null)
        }
    }

    private data class Connection(val socket: FakeWebSocket, val listener: WebSocketListener)

    private class FakeWebSocket(private val request: Request) : WebSocket {
        val sentTexts = mutableListOf<String>()
        val closeCodes = mutableListOf<Int>()
        var closeCalls = 0
            private set
        var isCancelled = false
            private set

        override fun request(): Request = request

        override fun queueSize(): Long = 0L

        override fun send(text: String): Boolean {
            sentTexts += text
            return true
        }

        override fun send(bytes: okio.ByteString): Boolean = true

        override fun close(code: Int, reason: String?): Boolean {
            closeCodes += code
            closeCalls += 1
            return true
        }

        override fun cancel() {
            isCancelled = true
        }
    }

    companion object {
        private fun response(request: Request): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build()
    }
}
