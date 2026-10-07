package com.example.claudephonemonitor.ui

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PairingConfig
import com.example.claudephonemonitor.monitor.PairingPayload
import com.example.claudephonemonitor.monitor.PairingRepository
import com.example.claudephonemonitor.monitor.PairingStore
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.RecentCompletion
import com.example.claudephonemonitor.monitor.ReminderStrength
import com.example.claudephonemonitor.monitor.SessionDisplayState
import com.example.claudephonemonitor.monitor.displayState
import com.example.claudephonemonitor.monitor.sortedTopSessions
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.WebSocketMonitorClient
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

private val StageColor = Color(0xFF1B1816)
private val InkColor = Color(0xFFF1E8DE)
private val MutedInkColor = Color(0xFF9B8F84)
private val TerracottaColor = Color(0xFFD97757)
private val AlertColor = Color(0xFFE18D7C)

internal class PairingScopedViewModelStoreOwner : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
}

@Composable
fun MonitorApp() {
    val context = LocalContext.current
    val store = remember { PairingStore(context) }
    var pairing by remember { mutableStateOf(store.load()) }

    PhoneMonitorTheme {
        val config = pairing
        if (config == null) {
            PairingScreen(
                onPaired = { paired ->
                    store.save(paired)
                    pairing = paired
                },
            )
        } else {
            val client = remember(config) {
                WebSocketMonitorClient(
                    endpoint = config.relayWsUrl,
                    installationId = config.installationId,
                    token = config.androidToken,
                )
            }
            val factory = remember(config) {
                object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                        MonitorViewModel(client) as T
                }
            }
            val viewModelStoreOwner = remember(config) { PairingScopedViewModelStoreOwner() }
            val viewModel: MonitorViewModel = viewModel(
                viewModelStoreOwner = viewModelStoreOwner,
                factory = factory,
            )
            val uiState by viewModel.uiState.collectAsStateWithLifecycle()
            LaunchedEffect(viewModel) {
                viewModel.setControlsVisible(false)
            }
            DisposableEffect(viewModelStoreOwner) {
                onDispose { viewModelStoreOwner.viewModelStore.clear() }
            }
            MonitorScreen(
                uiState = uiState,
                onToggleControls = viewModel::toggleControls,
                onHideControls = { viewModel.setControlsVisible(false) },
                onOpenUsage = viewModel::showUsagePage,
                onReturnToStatus = viewModel::showStatusPage,
                onReconnect = viewModel::reconnect,
                onRePair = {
                    store.clear()
                    pairing = null
                },
            )
        }
    }
}

@Composable
private fun PairingScreen(onPaired: (PairingConfig) -> Unit) {
    val scope = rememberCoroutineScope()
    val repository = remember { PairingRepository() }
    var message by remember {
        mutableStateOf("请扫描 Mac Relay 页面显示的配对二维码。")
    }
    var messageIsError by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents.isNullOrBlank()) {
            message = "没有读取到二维码，请重试。"
            messageIsError = true
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            busy = true
            message = "正在验证配对信息…"
            messageIsError = false
            runCatching {
                val payload = PairingPayload.parse(contents)
                repository.claim(payload, Build.MODEL.ifBlank { "Android phone" })
            }.onSuccess { config ->
                runCatching { onPaired(config) }
                    .onSuccess {
                        message = "配对成功。"
                        messageIsError = false
                    }
                    .onFailure { error ->
                        message = "已收到凭据，但无法安全保存：${error.message ?: "未知错误"}"
                        messageIsError = true
                    }
            }.onFailure { error ->
                message = error.message ?: "配对失败，请检查连接后重试。"
                messageIsError = true
            }
            busy = false
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(StageColor),
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 42.dp, vertical = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .weight(0.9f)
                    .fillMaxHeight(),
                contentAlignment = Alignment.Center,
            ) {
                ClawdProceduralView(
                    state = PetState.IDLE,
                    activity = ActivityVariation.BREATH,
                    isSilent = true,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Spacer(modifier = Modifier.width(24.dp))
            Column(
                modifier = Modifier.weight(1.1f),
                horizontalAlignment = Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                Text(
                    text = "CLAUDE PHONE MONITOR",
                    color = TerracottaColor,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
                Text(
                    text = "连接你的 Mac",
                    color = InkColor,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "在 Mac Relay 页面打开配对二维码，然后用这台设备扫码。",
                    color = MutedInkColor,
                    fontSize = 15.sp,
                    lineHeight = 23.sp,
                )
                Button(
                    enabled = !busy,
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = TerracottaColor,
                        contentColor = StageColor,
                    ),
                    onClick = {
                        messageIsError = false
                        scanner.launch(
                            ScanOptions().apply {
                                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                setPrompt("扫描 Mac Relay 配对二维码")
                                setBeepEnabled(false)
                                setOrientationLocked(true)
                            },
                        )
                    },
                ) {
                    Text(if (busy) "正在配对…" else "扫描配对二维码")
                }
                Text(
                    text = message,
                    color = if (messageIsError) AlertColor else MutedInkColor,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
                Text(
                    text = "二维码仅含一次性配对码；设备凭据会安全保存在 Android Keystore。",
                    color = Color(0xFF746A61),
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                )
            }
        }
    }
}

@Composable
internal fun MonitorScreen(
    uiState: com.example.claudephonemonitor.monitor.MonitorUiState,
    onToggleControls: () -> Unit,
    onHideControls: () -> Unit,
    onOpenUsage: () -> Unit,
    onReturnToStatus: () -> Unit,
    onReconnect: () -> Unit,
    onRePair: () -> Unit,
) {
    var showRePairConfirmation by remember { mutableStateOf(false) }
    var controlsReady by remember { mutableStateOf(!uiState.controlsVisible) }

    LaunchedEffect(uiState.controlsVisible) {
        if (!uiState.controlsVisible) controlsReady = true
    }

    val page = selectMonitorPage(uiState)
    val stateChange = uiState.stateChange?.takeIf { it.remainingMs > 0L }
    val displayPetState = uiState.petState

    Box(
        modifier = Modifier
            .fillMaxSize()
            .testTag("monitor-stage")
            .background(StageColor)
            .pointerInput(page) { detectTapGestures { if (page != MonitorPage.USAGE) onToggleControls() } }
            .semantics {
                contentDescription = "Claude phone monitor. Tap anywhere to show or hide controls."
            },
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize(),
        ) {
            val stageWidth = maxWidth
            val compact = stageWidth < 500.dp
            val short = maxHeight < 360.dp
            val stageScale = (stageWidth.value / 930f).coerceIn(0.72f, 1.5f)
            if (page == MonitorPage.USAGE) {
                UsageMonitorScreen(
                    uiState = uiState,
                    onReturnToStatus = onReturnToStatus,
                    compact = compact || short,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(
                            start = stageWidth * 0.04f,
                            end = stageWidth * 0.04f,
                            top = 42.dp,
                            bottom = 42.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SessionSummaryPanel(
                        snapshot = uiState.snapshot,
                        completion = uiState.recentSessionCompletion,
                        scale = stageScale,
                        modifier = Modifier
                            .weight(0.44f)
                            .fillMaxHeight()
                            .padding(start = if (compact) 0.dp else stageWidth * 0.078f),
                    )
                    if (page == MonitorPage.STATE_CHANGE && stateChange != null) {
                        StateChangePanel(
                            status = stateChange.status,
                            animationState = resolveStateChangeAnimationState(uiState),
                            completionName = stateChange.completionName,
                            runningCount = uiState.snapshot.mainRunningCount,
                            activity = uiState.activity,
                            compact = compact || short,
                            modifier = Modifier
                                .weight(0.56f)
                                .fillMaxHeight(),
                        )
                    } else {
                        ClawdProceduralView(
                            state = displayPetState,
                            activity = uiState.activity,
                            isSilent = displayPetState == PetState.OFFLINE,
                            modifier = Modifier
                                .weight(0.56f)
                                .fillMaxHeight()
                                .testTag("clawd")
                                .semantics { contentDescription = "Clawd animation: ${displayPetState.title}" },
                        )
                    }
                }
            }
        }

        if (page != MonitorPage.USAGE) {
            RelayIndicator(
                connected = uiState.isConnected,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = 24.dp, top = 20.dp),
            )
        }

        if (stateChange?.strength == ReminderStrength.WEAK) {
            WeakReminder(
                status = stateChange.status,
                completionName = stateChange.completionName,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(end = 24.dp, top = 68.dp),
            )
        }

        AnimatedVisibility(
            visible = controlsReady && uiState.controlsVisible && page != MonitorPage.USAGE,
            enter = fadeIn(animationSpec = tween(180)),
            exit = fadeOut(animationSpec = tween(140)),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            MonitorControls(
                onReconnect = onReconnect,
                onHide = onHideControls,
                onUsage = onOpenUsage,
                onRePair = { showRePairConfirmation = true },
            )
        }
    }

    if (showRePairConfirmation) {
        AlertDialog(
            onDismissRequest = { showRePairConfirmation = false },
            title = { Text("重新配对？") },
            text = { Text("这会清除本机保存的 Relay 凭据，需要再次扫描二维码。") },
            confirmButton = {
                TextButton(
                    modifier = Modifier.defaultMinSize(minWidth = 64.dp, minHeight = 48.dp),
                    onClick = {
                        showRePairConfirmation = false
                        onRePair()
                    },
                ) {
                    Text("清除并重新配对", color = AlertColor)
                }
            },
            dismissButton = {
                TextButton(
                    modifier = Modifier.defaultMinSize(minWidth = 64.dp, minHeight = 48.dp),
                    onClick = { showRePairConfirmation = false },
                ) {
                    Text("取消")
                }
            },
            containerColor = Color(0xFF28221F),
            titleContentColor = InkColor,
            textContentColor = MutedInkColor,
        )
    }
}

@Composable
private fun WeakReminder(
    status: PetState,
    completionName: String?,
    modifier: Modifier = Modifier,
) {
    val accent = statusColor(status)
    Row(
        modifier = modifier
            .widthIn(max = 360.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xF02B2521))
            .border(1.dp, accent.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
            .testTag("weak-reminder")
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(accent))
        Column {
            Text(
                text = status.title,
                color = accent,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.1.sp,
            )
            if (status == PetState.FINISH && !completionName.isNullOrBlank()) {
                Text(
                    text = "任务完成：$completionName",
                    color = InkColor,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StateChangePanel(
    status: PetState,
    animationState: PetState,
    completionName: String?,
    runningCount: Int?,
    activity: ActivityVariation,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val animationActivity = when {
        status == PetState.ERROR -> ActivityVariation.ALERT
        status == PetState.FINISH && animationState != PetState.WORKING -> ActivityVariation.CELEBRATE
        else -> activity
    }
    Column(
        modifier = modifier.padding(horizontal = if (compact) 2.dp else 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PixelText(
            text = status.title,
            color = statusColor(status),
            textHeight = if (compact) 24.sp else 30.sp,
            modifier = Modifier.testTag("state-change-title"),
        )
        if (status == PetState.FINISH && !completionName.isNullOrBlank()) {
            Text(
                text = "任务完成：$completionName",
                color = InkColor,
                fontSize = if (compact) 12.sp else 16.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (status == PetState.FINISH && animationState == PetState.WORKING) {
            Text(
                text = "仍有 ${runningCount?.toString() ?: "其他"} 项任务运行中",
                color = MutedInkColor,
                fontSize = if (compact) 10.sp else 13.sp,
                maxLines = 1,
            )
        }
        ClawdProceduralView(
            state = animationState,
            activity = animationActivity,
            isSilent = animationState == PetState.OFFLINE,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .testTag("clawd")
                .semantics { contentDescription = "Clawd animation: ${animationState.title}" },
        )
    }
}

private fun statusColor(state: PetState): Color = when (state) {
    PetState.WORKING -> TerracottaColor
    PetState.WAITING -> Color(0xFFF2BF69)
    PetState.FINISH -> Color(0xFF93BE81)
    PetState.ERROR -> AlertColor
    PetState.IDLE -> Color(0xFFB6B1AB)
    PetState.OFFLINE -> MutedInkColor
}

private fun statusColor(state: SessionDisplayState): Color = when (state) {
    SessionDisplayState.WORKING -> TerracottaColor
    SessionDisplayState.WAITING -> Color(0xFFF2BF69)
    SessionDisplayState.DONE -> Color(0xFF93BE81)
    SessionDisplayState.IDLE -> Color(0xFFB6B1AB)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionSummaryPanel(
    snapshot: MonitorSnapshot,
    completion: RecentCompletion?,
    scale: Float,
    modifier: Modifier = Modifier,
) {
    val sessions = snapshot.sortedTopSessions()
    val density = LocalDensity.current
    val titleSize = (13f * scale).sp
    val statusSize = (12f * scale).sp
    // Natural row height follows the user's font scale; only overflowing lists scroll.
    val rowHeight = maxOf((31f * scale).dp, with(density) { titleSize.toDp() * 1.9f })
    val statusWidth = maxOf((81f * scale).dp, with(density) { statusSize.toDp() * 6.0f })
    val markerSpace = (18f * scale).dp
    Box(modifier = modifier, contentAlignment = Alignment.CenterStart) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .testTag("session-list"),
        ) {
            FlowRow(
                modifier = Modifier.padding(start = markerSpace, bottom = (9f * scale).dp),
                horizontalArrangement = Arrangement.spacedBy((16f * scale).dp),
                verticalArrangement = Arrangement.spacedBy((4f * scale).dp),
            ) {
                Text(
                    text = "Main Sessions · ${formatSessionCount(snapshot.mainSessionCount)}",
                    color = MutedInkColor,
                    fontSize = (8f * scale).sp,
                    letterSpacing = (1.7f * scale).sp,
                    maxLines = 1,
                    modifier = Modifier.testTag("session-count"),
                )
                Text(
                    text = "Main Running · ${formatSessionCount(snapshot.mainRunningCount)}",
                    color = MutedInkColor,
                    fontSize = (8f * scale).sp,
                    letterSpacing = (1.1f * scale).sp,
                    maxLines = 1,
                    modifier = Modifier.testTag("running-count"),
                )
            }
            Text(
                text = "Total Running · ${formatSessionCount(snapshot.totalRunningCount)} · Includes subagents",
                color = MutedInkColor,
                fontSize = (8f * scale).sp,
                modifier = Modifier.padding(start = markerSpace, bottom = (9f * scale).dp).testTag("total-running-count"),
            )
            sessions.forEachIndexed { index, session ->
                val state = session.displayState(completion)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = rowHeight)
                        .testTag("session-${session.sessionId}")
                        .semantics(mergeDescendants = true) { contentDescription = "Session ${index + 1}: ${state.label}" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(modifier = Modifier.width(markerSpace)) {
                        if (index == 0) {
                            Box(
                                Modifier
                                    .width((1.5f * scale).dp)
                                    .height(with(density) { statusSize.toDp() })
                                    .background(statusColor(state)),
                            )
                        }
                    }
                    PixelText(
                        text = state.label,
                        color = statusColor(state),
                        textHeight = statusSize,
                        modifier = Modifier.width(statusWidth),
                    )
                    Text(
                        text = session.title,
                        color = InkColor,
                        fontSize = titleSize,
                        fontWeight = FontWeight.Normal,
                        letterSpacing = (0.35f * scale).sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            if (sessions.isEmpty()) {
                Text(
                    text = if (snapshot.sessions == null) "Waiting for sessions" else "No active sessions",
                    color = MutedInkColor,
                    fontSize = titleSize,
                    modifier = Modifier.padding(start = markerSpace, top = (8f * scale).dp),
                )
            }
        }
    }
}

internal fun formatSessionCount(count: Int?): String = count?.toString()?.padStart(2, '0') ?: "—"

@Composable
private fun RelayIndicator(connected: Boolean, modifier: Modifier = Modifier) {
    val indicatorColor = if (connected) Color(0xFFB5A79A) else Color(0xFF84675D)
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(indicatorColor),
        )
        Spacer(modifier = Modifier.width(7.dp))
        Text(
            text = if (connected) "RELAY CONNECTED" else "RELAY CONNECTING",
            color = indicatorColor,
            fontSize = 9.sp,
            fontWeight = FontWeight.Medium,
            letterSpacing = 1.2.sp,
        )
    }
}

@Composable
private fun MonitorControls(
    onReconnect: () -> Unit,
    onHide: () -> Unit,
    onUsage: () -> Unit,
    onRePair: () -> Unit,
) {
    Row(
        modifier = Modifier
            .padding(horizontal = 18.dp, vertical = 16.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(Color(0xF025211E))
            .padding(7.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ControlButton(label = "Reconnect", onClick = onReconnect)
        ControlButton(label = "Usage", onClick = onUsage, emphasized = true)
        ControlButton(label = "Re-pair", onClick = onRePair, emphasized = true)
        ControlButton(label = "Hide", onClick = onHide)
    }
}

@Composable
private fun ControlButton(
    label: String,
    onClick: () -> Unit,
    emphasized: Boolean = false,
) {
    Button(
        onClick = onClick,
        modifier = Modifier.heightIn(min = 48.dp),
        shape = RoundedCornerShape(13.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (emphasized) Color(0xFF493128) else Color(0xFF342D28),
            contentColor = if (emphasized) Color(0xFFE8A38B) else InkColor,
        ),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            horizontal = 16.dp,
            vertical = 10.dp,
        ),
    ) {
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.3.sp,
        )
    }
}
