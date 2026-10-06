package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState

/** Selects the visible monitor page from the same state consumed by Compose. */
enum class MonitorPage {
    STATUS,
    STATE_CHANGE,
}

internal fun selectMonitorPage(uiState: MonitorUiState): MonitorPage =
    if (uiState.stateChange?.remainingMs?.let { it > 0L } == true) {
        MonitorPage.STATE_CHANGE
    } else {
        MonitorPage.STATUS
    }

internal fun resolveStateChangeAnimationState(uiState: MonitorUiState): PetState {
    val change = uiState.stateChange?.takeIf { it.remainingMs > 0L } ?: return uiState.petState
    return if (change.status == PetState.FINISH && uiState.petState == PetState.WORKING) {
        PetState.WORKING
    } else {
        change.status
    }
}
