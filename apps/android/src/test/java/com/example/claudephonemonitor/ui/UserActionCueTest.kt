package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ApprovalStatus
import com.example.claudephonemonitor.monitor.ApprovalSummary
import com.example.claudephonemonitor.monitor.AwaitingUserAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UserActionCueTest {
    @Test fun anOldUnknownBridgeRecordCannotHideANewPlanOrInputInTheSameSession() {
        val old = approval(ApprovalStatus.UNKNOWN)
        listOf("approval", "question", "input", "permission").forEach { reason ->
            val action = action(reason).copy(taskId = "new-task", sequence = 10)
            assertEquals(listOf(action), userActionsForDisplay(listOf(action), listOf(old)))
        }
    }

    @Test fun onlyTheActualPendingPermissionInvocationIsDeduplicated() {
        val permission = action("permission")
        assertTrue(userActionsForDisplay(listOf(permission), listOf(approval(ApprovalStatus.PENDING))).isEmpty())
        listOf(approval(ApprovalStatus.PENDING).copy(taskId = "other-task"),
            approval(ApprovalStatus.PENDING).copy(toolName = "Edit"),
            approval(ApprovalStatus.PENDING).copy(sequence = 1)).forEach { other ->
            assertEquals(listOf(permission), userActionsForDisplay(listOf(permission), listOf(other)))
        }
        val plan = permission.copy(reason = "approval", toolName = "ExitPlanMode")
        assertEquals(listOf(plan), userActionsForDisplay(listOf(plan), listOf(approval(ApprovalStatus.PENDING))))
    }

    private fun action(reason: String) = AwaitingUserAction("session-a", "task-a", "Task A", reason, 2, "Bash")
    private fun approval(status: ApprovalStatus) = ApprovalSummary("11111111-1111-4111-8111-111111111111",
        "session-a", "task-a", "Task A", 3, "2026-10-07T01:00:00Z", status, false, "Bash")
}
