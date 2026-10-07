package com.example.claudephonemonitor.monitor

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
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

@OptIn(ExperimentalCoroutinesApi::class)
class WebSocketMonitorClientTest {
    @Test
    fun callbacksFromReplacedSocketCannotChangeCurrentConnectionOrCursor() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
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
        runCurrent()
        assertTrue(client.isConnected.value)
        client.send(MonitorCommand.Subscribe("install-1", "token", 10L))
        val currentEvents = events.toList()

        factory.closing(0, "late closing")
        factory.closed(0, "late close")
        factory.failure(0, "late failure")
        factory.message(0, """{"type":"event","event_type":"task_started","sequence":99}""")
        factory.open(0)
        runCurrent()

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
        runCurrent()
        val hello = socketC.sentTexts.map(::JSONObject)
            .first { it.optString("type") == "hello" }
        assertEquals(10L, hello.optLong("last_sequence"))
        assertTrue(client.isConnected.value)

        collector.cancelAndJoin()
    }

    @Test
    fun relayClosingDisconnectsImmediatelyAndManualReconnectPreservesCursor() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        val events = mutableListOf<MonitorEvent>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.open(0)
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":12}}""")
        runCurrent()

        // A peer close frame arrives before OkHttp can deliver onClosed.
        factory.closing(0, "relay restarting", 1001)
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)
        assertEquals(1, factory.connections.size)
        runCurrent()
        assertEquals("relay restarting", events.last().detail)
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })

        factory.closed(0, "relay restarting")
        factory.failure(0, "late failure")
        factory.message(0, """{"type":"event","event_type":"task_started","sequence":99}""")
        runCurrent()
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })

        client.connect()
        factory.open(1)
        factory.closing(0, "late closing")
        factory.open(0)
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":99}}""")
        runCurrent()
        assertTrue(client.isConnected.value)
        val hello = factory.connections[1].socket.sentTexts.map(::JSONObject)
            .first { it.optString("type") == "hello" }
        assertEquals(12L, hello.optLong("last_sequence"))
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })
        collector.cancelAndJoin()
    }

    @Test
    fun emptyPeerCloseUsesLegalAcknowledgementCodeAndFallbackDetail() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
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
        runCurrent()
        assertEquals("WebSocket closing", events.last().detail)
        collector.cancelAndJoin()
    }

    @Test
    fun synchronousPeerCloseBeforeFactoryReturnsDoesNotBlockManualReconnect() = runTest {
        val factory = FakeWebSocketFactory { index, socket, listener ->
            listener.onOpen(socket, response(socket.request()))
            if (index == 0) listener.onClosing(socket, 1001, "relay restarting")
        }
        val client = newClient(factory, backgroundScope)

        client.connect()
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)
        assertTrue(factory.connections[0].socket.isCancelled)

        client.connect()
        assertEquals(2, factory.connections.size)
        assertTrue(client.isConnected.value)
    }

    @Test
    fun synchronousOpenKeepsGenerationPublishedUntilFactoryReturns() = runTest {
        lateinit var client: WebSocketMonitorClient
        val factory = FakeWebSocketFactory { index, socket, listener ->
            listener.onOpen(socket, response(socket.request()))
            if (index == 0) {
                client.disconnect()
                client.connect()
            }
        }
        client = newClient(factory, backgroundScope)

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

    @Test
    fun networkFailureReconnectsOnceAndResubscribesWithLastReceivedCursor() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        val events = mutableListOf<MonitorEvent>()
        val collector = backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.open(0)
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":12}}""")
        factory.failure(0, "network lost")
        factory.closed(0, "late close")
        runCurrent()

        assertFalse(client.isConnected.value)
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })
        advanceTimeBy(999)
        runCurrent()
        assertEquals(1, factory.connections.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, factory.connections.size)

        factory.open(1)
        val sent = factory.connections[1].socket.sentTexts.map(::JSONObject)
        assertEquals(listOf("hello", "subscribe"), sent.map { it.optString("type") })
        assertTrue(sent.all { it.optLong("last_sequence") == 12L })
        factory.message(1, """{"type":"snapshot","snapshot":{"last_sequence":13,"claude_state":"working"}}""")
        factory.failure(0, "late failure")
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":99}}""")
        runCurrent()
        assertTrue(client.isConnected.value)
        assertEquals(13L, events.last().snapshot?.lastSequence)
        assertEquals(ClaudeState.WORKING, events.last().snapshot?.claudeState)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, factory.connections.size)
        collector.cancelAndJoin()
    }

    @Test
    fun repeatedFailuresBackOffToThirtySecondsAndSuccessfulOpenResetsDelay() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        client.connect()

        for (delayMs in listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L)) {
            val count = factory.connections.size
            factory.failure(count - 1, "relay unavailable")
            runCurrent()
            advanceTimeBy(delayMs - 1)
            runCurrent()
            assertEquals(count, factory.connections.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(count + 1, factory.connections.size)
        }

        // A usable socket resets the next delay; onClosed alone also reconnects.
        val connectedIndex = factory.connections.lastIndex
        factory.open(connectedIndex)
        assertTrue(client.isConnected.value)
        factory.closed(connectedIndex, "relay closed")
        runCurrent()
        advanceTimeBy(999)
        runCurrent()
        assertEquals(connectedIndex + 1, factory.connections.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(connectedIndex + 2, factory.connections.size)
    }

    @Test
    fun peerClosingSchedulesAutomaticReconnectWithoutWaitingForClosed() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        client.connect()
        factory.open(0)
        factory.closing(0, "relay restarting", 1001)
        runCurrent()
        assertFalse(client.isConnected.value)
        assertEquals(listOf(1000), factory.connections[0].socket.closeCodes)

        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, factory.connections.size)
        factory.open(1)
        factory.closed(0, "relay restarted")
        factory.failure(0, "late failure")
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue(client.isConnected.value)
        assertEquals(2, factory.connections.size)
    }

    @Test
    fun explicitDisconnectCancelsPendingRetryAndIgnoresLateCallbacks() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        client.connect()
        factory.open(0)
        factory.failure(0, "network lost")
        runCurrent()
        advanceTimeBy(999)
        client.disconnect()
        factory.closed(0, "late close")
        factory.failure(0, "late failure")
        factory.open(0)
        advanceTimeBy(60_000)
        runCurrent()
        assertFalse(client.isConnected.value)
        assertEquals(1, factory.connections.size)

        client.connect()
        factory.open(1)
        client.disconnect()
        factory.closing(1, "late closing")
        factory.failure(1, "late failure")
        advanceTimeBy(60_000)
        runCurrent()
        assertFalse(client.isConnected.value)
        assertEquals(2, factory.connections.size)
    }

    @Test
    fun manualConnectCancelsRetryAndRepeatedConnectDoesNotCreateAnotherSocket() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        client.connect()
        client.connect()
        assertEquals(1, factory.connections.size)
        factory.failure(0, "network lost")
        runCurrent()
        advanceTimeBy(999)

        client.connect()
        client.connect()
        assertEquals(2, factory.connections.size)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, factory.connections.size)
        factory.open(1)
        client.connect()
        assertTrue(client.isConnected.value)
        assertEquals(2, factory.connections.size)
    }

    @Test
    fun synchronousFactoryExceptionsAlsoRetryWithoutEscapingTheCaller() = runTest {
        val factory = FakeWebSocketFactory { index, socket, listener ->
            if (index < 2) throw IllegalStateException("temporarily unavailable")
            listener.onOpen(socket, response(socket.request()))
        }
        val client = newClient(factory, backgroundScope)
        client.connect()
        assertFalse(client.isConnected.value)
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, factory.connections.size)
        assertFalse(client.isConnected.value)
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(3, factory.connections.size)
        assertTrue(client.isConnected.value)
    }

    @Test
    fun rejectedSubscriptionSendReconnectsWithoutPublishingConnected() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        val events = mutableListOf<MonitorEvent>()
        val collector = backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.connections[0].socket.acceptMessages = false
        factory.open(0)
        runCurrent()
        assertFalse(client.isConnected.value)
        assertFalse(events.any { it.type == MonitorEventType.CONNECTED })
        advanceTimeBy(1_000)
        runCurrent()
        factory.open(1)
        runCurrent()
        assertTrue(client.isConnected.value)
        assertEquals(1, events.count { it.type == MonitorEventType.CONNECTED })
        collector.cancelAndJoin()
    }

    @Test
    fun unauthorizedHttpHandshakeStopsAutomaticRetriesAndAllowsManualRetry() = runTest {
        for (status in listOf(401, 403)) {
            val factory = FakeWebSocketFactory()
            val client = newClient(factory, backgroundScope)
            client.connect()
            factory.failure(0, "credentials rejected", status)
            runCurrent()
            advanceTimeBy(60_000)
            runCurrent()
            assertFalse(client.isConnected.value)
            assertEquals(1, factory.connections.size)

            client.connect()
            factory.open(1)
            assertTrue(client.isConnected.value)
            assertEquals(2, factory.connections.size)
            client.disconnect()
        }
    }

    @Test
    fun initialUnauthenticatedHelloAckIsAllowedButRelayAuthErrorStopsRetries() = runTest {
        val factory = FakeWebSocketFactory()
        val client = newClient(factory, backgroundScope)
        val events = mutableListOf<MonitorEvent>()
        val collector = backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect(events::add)
        }
        client.connect()
        factory.open(0)
        // Relay sends this before processing the Hello/Subscribe carrying the token.
        factory.message(0, """{"type":"hello_ack","accepted":false}""")
        factory.message(0, """{"type":"hello_ack","accepted":true}""")
        factory.message(0, """{"type":"snapshot","snapshot":{"last_sequence":12}}""")
        runCurrent()
        assertTrue(client.isConnected.value)
        assertFalse(events.any { it.type == MonitorEventType.DISCONNECTED })

        factory.message(0, """{"type":"error","code":"unauthorized","message":"invalid credentials","retryable":false}""")
        factory.closed(0, "credentials rejected")
        factory.failure(0, "late failure")
        runCurrent()
        assertFalse(client.isConnected.value)
        assertEquals("invalid credentials", events.last().detail)
        assertEquals(1, events.count { it.type == MonitorEventType.DISCONNECTED })
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, factory.connections.size)

        client.connect()
        factory.open(1)
        assertTrue(client.isConnected.value)
        assertEquals(2, factory.connections.size)
        collector.cancelAndJoin()
    }

    private fun newClient(factory: WebSocket.Factory, scope: CoroutineScope): WebSocketMonitorClient =
        WebSocketMonitorClient(
            endpoint = "ws://example.test/ws/android",
            installationId = "install-1",
            token = "token",
            webSocketFactory = factory,
            reconnectScope = scope,
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

        fun failure(index: Int, detail: String, status: Int? = null) {
            val connection = connections[index]
            val failedResponse = status?.let {
                response(connection.socket.request()).newBuilder().code(it).build()
            }
            connection.listener.onFailure(connection.socket, IllegalStateException(detail), failedResponse)
        }
    }

    private data class Connection(val socket: FakeWebSocket, val listener: WebSocketListener)

    private class FakeWebSocket(private val request: Request) : WebSocket {
        val sentTexts = mutableListOf<String>()
        val closeCodes = mutableListOf<Int>()
        var acceptMessages = true
        var closeCalls = 0
            private set
        var isCancelled = false
            private set

        override fun request(): Request = request

        override fun queueSize(): Long = 0L

        override fun send(text: String): Boolean {
            if (!acceptMessages) return false
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
