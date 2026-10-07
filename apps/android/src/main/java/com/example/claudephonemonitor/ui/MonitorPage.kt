package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.ReminderStrength

/** Selects the visible monitor page from the same state consumed by Compose. */
enum class MonitorPage {
    STATUS,
    STATE_CHANGE,
    USAGE,
    APPROVAL,
}

internal fun selectMonitorPage(uiState: MonitorUiState): MonitorPage =
    if (uiState.approvalReminder?.remainingMs?.let { it > 0L } == true) {
        MonitorPage.APPROVAL
    } else if (uiState.stateChange?.let {
        it.remainingMs > 0L && it.strength == ReminderStrength.STRONG
    } == true) {
        MonitorPage.STATE_CHANGE
    } else if (uiState.usagePageVisible) {
        MonitorPage.USAGE
    } else {
        MonitorPage.STATUS
    }

internal fun resolveStateChangeAnimationState(uiState: MonitorUiState): PetState {
    val change = uiState.stateChange?.takeIf {
        it.remainingMs > 0L && it.strength == ReminderStrength.STRONG
    } ?: return uiState.petState
    return if (change.status == PetState.FINISH && uiState.petState == PetState.WORKING) {
        PetState.WORKING
    } else {
        change.status
    }
}
