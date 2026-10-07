package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.ReminderStrength
import com.example.claudephonemonitor.monitor.StateChangeUi
import org.junit.Assert.assertEquals
import org.junit.Test

class MonitorPageTest {
    @Test
    fun pageSelectorOnlyRoutesAnActiveStrongReminder() {
        val status = MonitorUiState(petState = PetState.WAITING)
        assertEquals(MonitorPage.STATUS, selectMonitorPage(status))
        assertEquals(
            MonitorPage.STATUS,
            selectMonitorPage(status.copy(stateChange = StateChangeUi(PetState.ERROR, 0L))),
        )
        assertEquals(
            MonitorPage.STATE_CHANGE,
            selectMonitorPage(status.copy(stateChange = StateChangeUi(PetState.ERROR, 1L, strength = ReminderStrength.STRONG))),
        )
        assertEquals(
            MonitorPage.STATE_CHANGE,
            selectMonitorPage(status.copy(stateChange = StateChangeUi(PetState.WAITING, 14_999L, strength = ReminderStrength.STRONG))),
        )
        assertEquals(
            MonitorPage.STATE_CHANGE,
            selectMonitorPage(status.copy(stateChange = StateChangeUi(PetState.FINISH, 15_000L, strength = ReminderStrength.STRONG))),
        )
        assertEquals(
            MonitorPage.STATUS,
            selectMonitorPage(status.copy(stateChange = StateChangeUi(PetState.FINISH, 5_000L))),
        )
    }

    @Test
    fun finishChangeShowsFinishPageButKeepsWorkingAnimationWhenAnotherTaskRuns() {
        val uiState = MonitorUiState(
            petState = PetState.WORKING,
            stateChange = StateChangeUi(
                status = PetState.FINISH,
                remainingMs = 15_000L,
                completionName = "release prep",
                strength = ReminderStrength.STRONG,
            ),
        )

        assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(uiState))
        assertEquals(PetState.WORKING, resolveStateChangeAnimationState(uiState))
        assertEquals(PetState.WORKING, uiState.petState)
        assertEquals("release prep", uiState.stateChange?.completionName)
        assertEquals(ClawdFrameSet.TYPING, resolveClawdAnimation(resolveStateChangeAnimationState(uiState), uiState.activity).frameSet)
        assertEquals(ClawdAction.WORKING_TYPING, resolveClawdAction(resolveStateChangeAnimationState(uiState)))
    }

    @Test
    fun everyPetStateCanRenderAsItsOwnVisibleChangePage() {
        PetState.entries.forEach { state ->
            val uiState = MonitorUiState(
                petState = PetState.IDLE,
                stateChange = StateChangeUi(state, 2_000L, strength = ReminderStrength.STRONG),
            )
            assertEquals("$state must use the large state-change page", MonitorPage.STATE_CHANGE, selectMonitorPage(uiState))
            assertEquals(state, resolveStateChangeAnimationState(uiState))
        }
    }

    @Test
    fun weakReminderStaysOnUsageAndStrongReminderTemporarilyTakesOver() {
        val uiState = MonitorUiState(
            petState = PetState.WORKING,
            stateChange = StateChangeUi(PetState.FINISH, 8_000L, "Codex"),
            usagePageVisible = true,
        )

        assertEquals(MonitorPage.USAGE, selectMonitorPage(uiState))
        assertEquals(MonitorPage.STATUS, selectMonitorPage(uiState.copy(usagePageVisible = false)))
        assertEquals(
            MonitorPage.STATE_CHANGE,
            selectMonitorPage(uiState.copy(stateChange = uiState.stateChange?.copy(strength = ReminderStrength.STRONG))),
        )
        assertEquals(
            MonitorPage.USAGE,
            selectMonitorPage(uiState.copy(stateChange = null)),
        )
    }
}
