package com.example.claudephonemonitor.ui

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PairingConfig
import com.example.claudephonemonitor.monitor.PairingPayload
import com.example.claudephonemonitor.monitor.PairingRepository
import com.example.claudephonemonitor.monitor.PairingStore
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
            val viewModel: MonitorViewModel = viewModel(
                key = "monitor-${config.installationId}",
                factory = factory,
            )
            val uiState by viewModel.uiState.collectAsStateWithLifecycle()
            LaunchedEffect(viewModel) {
                viewModel.setControlsVisible(false)
            }
            DisposableEffect(config) {
                onDispose { client.disconnect() }
            }
            MonitorScreen(
                uiState = uiState,
                onToggleControls = viewModel::toggleControls,
                onHideControls = { viewModel.setControlsVisible(false) },
                onOpenUsage = viewModel::showUsagePage,
                onReturnToStatus = viewModel::showStatusPage,
                onReconnect = {
                    client.disconnect()
                    client.connect()
                },
                onRePair = {
                    client.disconnect()
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
private fun MonitorScreen(
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
            val compact = maxWidth < 500.dp
            val short = maxHeight < 360.dp
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
                            start = if (compact) 8.dp else 18.dp,
                            end = if (compact) 8.dp else 18.dp,
                            top = 42.dp,
                            bottom = 12.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SessionSummaryPanel(
                        snapshot = uiState.snapshot,
                        state = displayPetState,
                        compact = compact || short,
                        modifier = Modifier
                            .weight(if (compact) 0.44f else 1.05f)
                            .fillMaxHeight(),
                    )
                    if (page == MonitorPage.STATE_CHANGE && stateChange != null) {
                        StateChangePanel(
                            status = stateChange.status,
                            animationState = resolveStateChangeAnimationState(uiState),
                            completionName = stateChange.completionName,
                            runningCount = uiState.snapshot.runningCount,
                            activity = uiState.activity,
                            compact = compact || short,
                            modifier = Modifier
                                .weight(if (compact) 0.56f else 1.4f)
                                .fillMaxHeight(),
                        )
                    } else {
                        ClawdProceduralView(
                            state = displayPetState,
                            activity = uiState.activity,
                            isSilent = displayPetState == PetState.OFFLINE,
                            modifier = Modifier
                                .weight(if (compact) 0.56f else 1.4f)
                                .fillMaxHeight(),
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
        Text(
            text = status.title,
            color = Color(status.color),
            fontSize = if (compact) 28.sp else 42.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = if (compact) 1.2.sp else 2.sp,
            maxLines = 1,
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
                .weight(1f),
        )
    }
}

@Composable
private fun SessionSummaryPanel(
    snapshot: com.example.claudephonemonitor.monitor.MonitorSnapshot,
    state: PetState,
    compact: Boolean,
    modifier: Modifier = Modifier,
) {
    val stateLabel = when (state) {
        PetState.IDLE -> "空闲"
        PetState.WORKING -> "运行中"
        PetState.WAITING -> "等待输入"
        PetState.FINISH -> "已完成"
        PetState.ERROR -> "需要处理"
        PetState.OFFLINE -> "离线"
    }
    Column(
        modifier = modifier.padding(
            start = if (compact) 2.dp else 8.dp,
            end = if (compact) 3.dp else 6.dp,
            top = 4.dp,
            bottom = 8.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 7.dp),
    ) {
        Text(
            text = state.title,
            color = when (state) {
                PetState.WORKING -> Color(0xFF8DE6A8)
                PetState.ERROR -> AlertColor
                else -> InkColor
            },
            fontSize = if (compact) 18.sp else 22.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.2.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(stateLabel, color = MutedInkColor, fontSize = if (compact) 10.sp else 12.sp, letterSpacing = 0.7.sp)

        val sessions = snapshot.sessions
        if (sessions != null) {
            Text(
                text = "运行中 ${snapshot.runningCount?.toString() ?: "—"} · 会话 ${snapshot.sessionCount?.toString() ?: "—"}",
                color = TerracottaColor,
                fontSize = if (compact) 9.sp else 11.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 5.dp),
            ) {
                sessions.take(5).forEach { session ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 6.dp),
                    ) {
                        Text(
                            text = session.title,
                            color = InkColor,
                            fontSize = if (compact) 10.sp else 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = when (session.claudeState) {
                                com.example.claudephonemonitor.monitor.ClaudeState.IDLE -> "空闲"
                                com.example.claudephonemonitor.monitor.ClaudeState.WORKING -> "运行中"
                                com.example.claudephonemonitor.monitor.ClaudeState.WAITING -> "等待"
                            },
                            color = when (session.claudeState) {
                                com.example.claudephonemonitor.monitor.ClaudeState.WORKING -> Color(0xFF8DE6A8)
                                com.example.claudephonemonitor.monitor.ClaudeState.WAITING -> Color(0xFFF6C76D)
                                else -> MutedInkColor
                            },
                            fontSize = if (compact) 9.sp else 10.sp,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        snapshot.recentCompletion?.let { completion ->
            Text(
                text = "已完成：${completion.displayName}",
                color = TerracottaColor,
                fontSize = if (compact) 9.sp else 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

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
