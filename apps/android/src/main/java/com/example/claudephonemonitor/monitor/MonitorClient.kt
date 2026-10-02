package com.example.claudephonemonitor.monitor

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface MonitorClient {
    val events: Flow<MonitorEvent>
    val isConnected: StateFlow<Boolean>

    fun connect()

    fun disconnect()

    fun send(command: MonitorCommand)
}
