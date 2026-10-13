# Magpie plugin USB fixture

This is a physical-Android test of the real chain: synthetic native Codex files in an isolated HOME → installed Magpie CLI → Magpie Web's Bun plugin host → temporary localhost paired Relay → production Android pairing store and `MainActivity`/monitor UI. The fixture does not publish events itself, call `createCollectorRuntime`, or touch real session files. The `rename` case edits only the synthetic native Codex title index/SQLite because Magpie 0.1.1211 has no session-rename UI or endpoint; it is not a Magpie UI rename.

## Run

Use the approved Android device and installed runtimes; this runner starts only a temporary localhost Relay and the actual Magpie Web process. It prints a ready record with the live credential file path only; never print or copy the file contents into logs. Leave the runner alive for the test and for the separate desktop-plugin verification requested by the operator.

```sh
node tests/device-magpie-plugin-relay.mjs \
  --magpie /Users/wenzhengfeng/.local/bin/magpie \
  --bun /Users/wenzhengfeng/.cache/magpie/bun/1.4.3/magpie-bun
```

In another terminal, reverse the fixture port and install/run the isolated debug app and instrumentation (not the normal app or `.magpie` variant):

```sh
ADB=/opt/homebrew/share/android-commandlinetools/platform-tools/adb
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
"$ADB" -s USFBB23A23203071 reverse tcp:18889 tcp:18889
./gradlew --offline -PdeviceTestApplicationIdSuffix=.magpieusbtest \
  :apps:android:assembleDebug :apps:android:assembleDebugAndroidTest
"$ADB" -s USFBB23A23203071 install -r apps/android/build/outputs/apk/debug/android-debug.apk
"$ADB" -s USFBB23A23203071 install -r apps/android/build/outputs/apk/androidTest/debug/android-debug-androidTest.apk
"$ADB" -s USFBB23A23203071 shell am instrument -w \
  -e class com.example.claudephonemonitor.ui.MagpiePluginDeviceTest \
  -e deviceRelayUrl http://127.0.0.1:18889/device-test \
  com.example.claudephonemonitor.magpieusbtest.test/androidx.test.runner.AndroidJUnitRunner
```

Verify the exact Gradle APK output paths before installation if the Android Gradle Plugin version changes. Keep the existing `.myc23test`, `.test`, and production app packages/data untouched. Capture output from the device under the isolated test app's external files directory (`Android/data/com.example.claudephonemonitor.magpieusbtest/files/magpie-usb/`). After the phone test, open the isolated app once with `am start -n com.example.claudephonemonitor.magpieusbtest/com.example.claudephonemonitor.MainActivity` to keep its real monitor screen visible for the operator.

## Fixture API and cleanup

The runner reports a temporary root containing a ready record and private `live-relay.json`. Its `/device-test/config` endpoint is synthetic-only pairing; `/device-test/live-config` is the independent `magpie-usb-live` pairing for a later real-desktop read-only check. The latter file is mode 0600 and must be copied only by the authorized operator to the real plugin's private `monitor-sessions/relay.json`; never install the synthetic pairing into a real configuration. The fixture remains running until explicitly shut down with `POST /device-test/shutdown` after desktop verification. Remove the ADB reverse rule afterward with `adb -s USFBB23A23203071 reverse --remove tcp:18889`.

The instrumentation exercises a fresh pairing, visible synthetic title/history, verified turn start/completion, a title change in native synthetic metadata, lifecycle uncertainty without a false DONE, and phone WebSocket reconnection. Screenshots and test outputs are local test artifacts, not evidence of Magpie foreground/focus state. No focus/foreground activity is collected. No system service, daemon, launch agent, or production configuration is created.

## Observed validation (2026-10-13)

Offline Gradle build of the isolated `.magpieusbtest` app and instrumentation APK succeeded. On macOS `darwin/arm64` and Android device `USFBB23A23203071` (DBR-W00), the scoped `MagpiePluginDeviceTest` returned `OK (1 test)` in 11.609 seconds. Its verbatim instrumentation output is preserved at `reports/device-magpie-plugin/magpie-plugin-instrumentation.stdout.txt`. This synthetic fixture run used Magpie `0.1.1211` and Bun `1.4.2`; it exercised official Magpie CLI/Bun host, paired Relay, encrypted Android `PairingStore`, and production `MainActivity` for synthetic native history/title, verified working/finished, unknown without false DONE, plugin off/on, full Web restart, and phone reconnection. Screenshot: `reports/device-magpie-plugin/magpie-synthetic-title-history.png`.

A separate real-desktop read-only verification used the current Magpie plugin host with Bun `1.4.3`: 3,352 local sessions observed, diagnostics empty, Relay connected with zero pending events, current Codex title matched across native source/Magpie/Relay/phone during a temporary native rename, and the original title was restored and verified. The real session had recent activity and a current working turn; the phone showed its live title/history (`reports/device-magpie-plugin/phone-live-renamed.png`). Details are in `reports/device-magpie-plugin/live-native-rename.json`; no private title is copied here. This verifies title/history and current-session signal on the tested setup, not Magpie UI rename, window focus/foreground state, or every agent's execution status. The current user asked to retain the fixture while reviewing; cleanup remains pending. Never expose credential file contents or copy synthetic credentials to production config.
