package com.example.claudephonemonitor.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorEventType
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.ClaudeState
import com.example.claudephonemonitor.monitor.PairingConfig
import com.example.claudephonemonitor.monitor.PetState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelOwnershipTest {
    @Test
    fun pairingConfigReplacementClearsOldOwnerAndBindsNewClientExactlyOnce() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val ownerA = PairingScopedViewModelStoreOwner()
        val clientA = CountingMonitorClient()
        var clockA = 100L
        try {
            val providerA = ViewModelProvider(ownerA, monitorFactory(clientA) { clockA })
            val vmA = providerA[MonitorViewModel::class.java]
            assertSame(vmA, providerA[MonitorViewModel::class.java])
            runCurrent()
            assertEquals(1, clientA.connectCount)

            clientA.emit(snapshot(1, ClaudeState.IDLE))
            clientA.emit(snapshot(2, ClaudeState.WORKING))
            runCurrent()
            assertEquals(PetState.WORKING, vmA.uiState.value.petState)
            assertEquals(5_000L, vmA.uiState.value.stateChange?.remainingMs)

            val configA = PairingConfig("http://relay", "ws://relay", "install-same", "synthetic-A")
            val configB = configA.copy(androidToken = "synthetic-B")
            assertEquals(configA.installationId, configB.installationId)
            assertNotSame(ownerA, PairingScopedViewModelStoreOwner())

            // A changed PairingConfig receives a new owner; disposing the old
            // owner clears its VM, cancels its timer/collector, and closes A.
            ownerA.viewModelStore.clear()
            runCurrent()
            assertEquals(1, clientA.disconnectCount)

            val ownerB = PairingScopedViewModelStoreOwner()
            val clientB = CountingMonitorClient()
            var clockB = 200L
            val providerB = ViewModelProvider(ownerB, monitorFactory(clientB) { clockB })
            val vmB = providerB[MonitorViewModel::class.java]
            assertSame(vmB, providerB[MonitorViewModel::class.java])
            runCurrent()
            assertEquals(1, clientB.connectCount)

            clientB.emit(snapshot(1, ClaudeState.IDLE))
            runCurrent()
            assertEquals(PetState.IDLE, vmB.uiState.value.petState)

            // A is no longer collected after owner disposal, and can never
            // feed events into the newly paired B ViewModel.
            clockA = 20_000L
            clientA.emit(snapshot(99, ClaudeState.IDLE, ComputerState.OFFLINE))
            clockB = 1_000L
            runCurrent()
            advanceTimeBy(16_000L)
            runCurrent()
            assertEquals(PetState.WORKING, vmA.uiState.value.petState)
            assertEquals(5_000L, vmA.uiState.value.stateChange?.remainingMs)
            assertEquals(PetState.IDLE, vmB.uiState.value.petState)
            assertEquals(1L, vmB.uiState.value.snapshot.lastSequence)
            assertEquals(1, clientB.connectCount)

            ownerB.viewModelStore.clear()
            runCurrent()
            assertEquals(1, clientB.disconnectCount)
        } finally {
            ownerA.viewModelStore.clear()
            Dispatchers.resetMain()
        }
    }

    private fun monitorFactory(client: MonitorClient, clock: () -> Long) =
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                MonitorViewModel(client, clock) as T
        }

    private fun snapshot(
        sequence: Long,
        state: ClaudeState,
        computerState: ComputerState = ComputerState.ONLINE,
    ) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(
            computerState = computerState,
            claudeState = state,
            lastSequence = sequence,
        ),
    )

    private class CountingMonitorClient : MonitorClient {
        private val mutableEvents = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 8)
        override val events = mutableEvents
        override val isConnected = MutableStateFlow(false)
        var connectCount = 0
            private set
        var disconnectCount = 0
            private set

        override fun connect() {
            connectCount += 1
            isConnected.value = true
        }

        override fun disconnect() {
            disconnectCount += 1
            isConnected.value = false
        }

        override fun send(command: MonitorCommand) = Unit

        fun emit(event: MonitorEvent) {
            check(mutableEvents.tryEmit(event))
        }
    }
}
