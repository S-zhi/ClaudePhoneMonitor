package com.example.claudephonemonitor.ui

import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.PetState

/**
 * Anthropic Claude Code official mascot Clawd assets catalogue.
 * Supports both local bundled assets (zero latency, offline) and official CDN fallbacks.
 */
enum class ClawdPose(
    val assetFilename: String,
    val officialCdnUrl: String,
    val description: String,
    val isAnimated: Boolean = true,
) {
    // Core Poses
    STILL(
        assetFilename = "Clawd-Still.png",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Still.png",
        description = "Clawd Still (Offline / Rest)",
        isAnimated = false,
    ),
    WAVING(
        assetFilename = "Clawd-Waving.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Waving.gif",
        description = "Clawd Waving Hello",
    ),
    WALKING(
        assetFilename = "Clawd-Walking.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Walking.gif",
        description = "Clawd Strolling (Idle)",
    ),
    CRAB_WALKING(
        assetFilename = "Clawd-CrabWalking.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-CrabWalking.gif",
        description = "Clawd Crab Walking (Working / Loading)",
    ),
    JUMPING(
        assetFilename = "Clawd-Jumping.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Jumping.gif",
        description = "Clawd Jumping",
    ),
    JUMPING_HAPPY(
        assetFilename = "Clawd-JumpingHappy.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-JumpingHappy.gif",
        description = "Clawd Happy Jump (Finish)",
    ),
    POINTING(
        assetFilename = "Clawd-Pointing.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Pointing.gif",
        description = "Clawd Pointing (Waiting for Input)",
    ),
    DANCING(
        assetFilename = "Clawd-Dancing.gif",
        officialCdnUrl = "https://claude.ai/images/spotlights/claude-code-celebration/Clawd-Dancing.gif",
        description = "Clawd Dancing Celebration",
    ),
    LURKING(
        assetFilename = "Clawd-Lurking.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/core/Clawd-Lurking.gif",
        description = "Clawd Lurking from Edge",
    ),

    // Persona / Costume Poses
    MAGNIFIER(
        assetFilename = "Clawd-Magnifier.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Magnifier.gif",
        description = "Detective Clawd with Magnifier",
    ),
    RACING_CAR(
        assetFilename = "Clawd-RacingCar.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-RacingCar.gif",
        description = "Speed Racer Clawd",
    ),
    SKATEBOARD(
        assetFilename = "Clawd-Skateboard.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Skateboard.gif",
        description = "Skater Clawd",
    ),
    SOCCER(
        assetFilename = "Clawd-Soccer.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Soccer.gif",
        description = "Clawd Football Juggling",
    ),
    BASKETBALL(
        assetFilename = "Clawd-Basketball.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Basketball.gif",
        description = "Clawd Dribbling Basketball",
    ),
    TRUMPET(
        assetFilename = "Clawd-Trumpet.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Trumpet.gif",
        description = "Musician Clawd Playing Trumpet",
    ),
    BOAT(
        assetFilename = "Clawd-Boat-loop.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/7bbe5052.gif",
        description = "Captain Clawd Sailing Boat",
    ),
    CLOUD(
        assetFilename = "Clawd-Cloud-once.gif",
        officialCdnUrl = "https://claude.ai/images/clawd/persona/Clawd-Cloud-once.gif",
        description = "Clawd Riding Cloud",
    );

    val assetUri: String
        get() = "file:///android_asset/clawd/$assetFilename"
}

/**
 * Persona themes that allow users to override or lock a specific Clawd costume.
 */
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

/**
 * Maps monitor state and activity to the most suitable Clawd mascot animation pose.
 */
fun resolveClawdPose(
    petState: PetState,
    activity: ActivityVariation,
    persona: ClawdPersona = ClawdPersona.AUTO,
): ClawdPose {
    // If user locked a specific persona costume and we're not in an emergency error or offline state
    if (persona != ClawdPersona.AUTO && persona.pose != null &&
        petState != PetState.OFFLINE && petState != PetState.ERROR
    ) {
        return persona.pose
    }

    return when (petState) {
        PetState.OFFLINE -> ClawdPose.STILL

        PetState.IDLE -> when (activity) {
            ActivityVariation.BREATH -> ClawdPose.WALKING
            ActivityVariation.WAIT -> ClawdPose.WAVING
            else -> ClawdPose.WALKING
        }

        PetState.WORKING -> when (activity) {
            ActivityVariation.TOOL -> ClawdPose.MAGNIFIER
            ActivityVariation.THINK -> ClawdPose.CRAB_WALKING
            ActivityVariation.ALERT -> ClawdPose.CRAB_WALKING
            else -> ClawdPose.CRAB_WALKING
        }

        PetState.WAITING -> when (activity) {
            ActivityVariation.WAIT -> ClawdPose.POINTING
            ActivityVariation.THINK -> ClawdPose.LURKING
            else -> ClawdPose.POINTING
        }

        PetState.FINISH -> when (activity) {
            ActivityVariation.CELEBRATE -> ClawdPose.DANCING
            else -> ClawdPose.JUMPING_HAPPY
        }

        PetState.ERROR -> when (activity) {
            ActivityVariation.ALERT -> ClawdPose.CRAB_WALKING
            else -> ClawdPose.LURKING
        }
    }
}
