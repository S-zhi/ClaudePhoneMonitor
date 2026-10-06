package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState

/**
 * Locally bundled Clawd image catalogue. The monitor renderer uses the procedural sprite frames below
 * and never fetches images over the network.
 */
enum class ClawdPose(
    val assetFilename: String,
    val description: String,
    val isAnimated: Boolean = true,
) {
    // Core poses
    STILL("Clawd-Still.png", "Clawd Still (Offline / Rest)", isAnimated = false),
    WAVING("Clawd-Waving.gif", "Clawd Waving Hello"),
    WALKING("Clawd-Walking.gif", "Clawd Strolling (Idle)"),
    CRAB_WALKING("Clawd-CrabWalking.gif", "Clawd Crab Walking (Working / Alert)"),
    JUMPING("Clawd-Jumping.gif", "Clawd Jumping"),
    JUMPING_HAPPY("Clawd-JumpingHappy.gif", "Clawd Happy Jump (Finish)"),
    POINTING("Clawd-Pointing.gif", "Clawd Pointing (Waiting for Input)"),
    DANCING("Clawd-Dancing.gif", "Clawd Dancing Celebration"),
    LURKING("Clawd-Lurking.gif", "Clawd Lurking from Edge"),

    // Persona / costume poses
    MAGNIFIER("Clawd-Magnifier.gif", "Detective Clawd with Magnifier"),
    RACING_CAR("Clawd-RacingCar.gif", "Speed Racer Clawd"),
    SKATEBOARD("Clawd-Skateboard.gif", "Skater Clawd"),
    SOCCER("Clawd-Soccer.gif", "Clawd Football Juggling"),
    BASKETBALL("Clawd-Basketball.gif", "Clawd Dribbling Basketball"),
    TRUMPET("Clawd-Trumpet.gif", "Musician Clawd Playing Trumpet"),
    BOAT("Clawd-Boat-loop.gif", "Captain Clawd Sailing Boat"),
    CLOUD("Clawd-Cloud-once.gif", "Clawd Riding Cloud");

    val assetUri: String
        get() = "file:///android_asset/clawd/$assetFilename"
}

/** Persona themes that can select a locally bundled costume. */
enum class ClawdPersona(val label: String, val icon: String, val pose: ClawdPose?) {
    AUTO("Smart Auto", "✨", null),
    MAGNIFIER("Detective", "🔍", ClawdPose.MAGNIFIER),
    RACER("Racer", "🏎️", ClawdPose.RACING_CAR),
    SKATER("Skater", "🛹", ClawdPose.SKATEBOARD),
    DANCER("Dancer", "🕺", ClawdPose.DANCING),
    BOAT("Captain", "⛵", ClawdPose.BOAT),
    SOCCER("Football", "⚽", ClawdPose.SOCCER),
    BASKETBALL("Hoops", "🏀", ClawdPose.BASKETBALL),
    TRUMPET("Trumpet", "🎺", ClawdPose.TRUMPET),
    CLOUD("Cloud", "☁️", ClawdPose.CLOUD),
}

/** Names the procedural frame sequence used for a monitor state. */
enum class ClawdFrameSet {
    STILL,
    TYPING,
    CRAB,
    POINT,
    DANCE,
    JUMP,
    ALERT,
}

data class ClawdAnimation(
    val frameSet: ClawdFrameSet,
    val poses: List<List<String>>,
    val sequence: IntArray,
    val frameDurationMs: Int,
)

private const val FRAME_DURATION_MS = 90

private val STILL_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.STILL,
    poses = ClawdSpriteData.STILL_POSES,
    sequence = ClawdSpriteData.STILL_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)
private val TYPING_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.TYPING,
    poses = ClawdSpriteData.TYPING_POSES,
    sequence = ClawdSpriteData.TYPING_SEQUENCE,
    frameDurationMs = 320,
)
private val CRAB_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.CRAB,
    poses = ClawdSpriteData.CRAB_POSES,
    sequence = ClawdSpriteData.CRAB_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)
private val POINT_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.POINT,
    poses = ClawdSpriteData.POINT_POSES,
    sequence = ClawdSpriteData.POINT_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)
private val DANCE_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.DANCE,
    poses = ClawdSpriteData.DANCE_POSES,
    sequence = ClawdSpriteData.DANCE_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)
private val JUMP_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.JUMP,
    poses = ClawdSpriteData.JUMP_POSES,
    sequence = ClawdSpriteData.JUMP_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)
private val ALERT_ANIMATION = ClawdAnimation(
    frameSet = ClawdFrameSet.ALERT,
    // Keep the same Clawd silhouette and motion; the renderer adds a small alert accent.
    poses = ClawdSpriteData.CRAB_POSES,
    sequence = ClawdSpriteData.CRAB_SEQUENCE,
    frameDurationMs = FRAME_DURATION_MS,
)

/**
 * Resolves a monitor state to its local sprite sequence. Typing advances slowly at 320 ms per pose;
 * other animated sequences advance at 90 ms per frame. Idle and offline share STILL.
 */
fun resolveClawdAnimation(
    petState: PetState,
    activity: ActivityVariation,
    isSilent: Boolean = false,
): ClawdAnimation = when {
    isSilent || petState == PetState.OFFLINE || petState == PetState.IDLE -> STILL_ANIMATION
    petState == PetState.WORKING -> TYPING_ANIMATION
    petState == PetState.WAITING -> POINT_ANIMATION
    petState == PetState.FINISH && activity == ActivityVariation.CELEBRATE -> DANCE_ANIMATION
    petState == PetState.FINISH -> JUMP_ANIMATION
    petState == PetState.ERROR -> ALERT_ANIMATION
    else -> STILL_ANIMATION
}

/** Maps monitor state to the corresponding locally bundled pose. */
fun resolveClawdPose(
    petState: PetState,
    activity: ActivityVariation,
    persona: ClawdPersona = ClawdPersona.AUTO,
): ClawdPose {
    if (persona != ClawdPersona.AUTO && persona.pose != null &&
        petState != PetState.OFFLINE && petState != PetState.ERROR
    ) {
        return persona.pose
    }

    return when (petState) {
        PetState.OFFLINE,
        PetState.IDLE -> ClawdPose.STILL

        PetState.WORKING -> ClawdPose.CRAB_WALKING
        PetState.WAITING -> ClawdPose.POINTING
        PetState.FINISH -> if (activity == ActivityVariation.CELEBRATE) {
            ClawdPose.DANCING
        } else {
            ClawdPose.JUMPING_HAPPY
        }
        PetState.ERROR -> ClawdPose.CRAB_WALKING
    }
}
