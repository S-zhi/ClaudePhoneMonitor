# Issue 26 audibility follow-up (2026-10-08)

This follow-up addresses the quiet sound reported during handset listening. The earlier path combined a WAV peak of -13.16 dBFS with `SoundPool.play()` gain 0.45, applying attenuation at both the sample and player stages. The player now uses gain 1.0, and the same 440 ms PCM waveform is linearly scaled to a -1.00 dBFS sample peak. It remains mono, PCM16, 22,050 Hz; measured RMS is -6.817 dBFS, sample clipping is absent, and FFmpeg EBU R128 reports true peak -1.0 dBFS. No new dependency was added.

The production change affects only the WAV and SoundPool playback gain. Production playback still follows the user's notification/ringer/DND settings; it does not change system volume or DND. The separately gated manual instrumentation preview temporarily sets NORMAL ringer mode, disables DND, and changes notification/ring indices through `AudioManager`. It snapshots and restores stream indices/mute states, then the surrounding fixture restores DND and access. The preview requires `issue26_manual_audio=notification-preview`; `issue26_preview_volume` accepts 1–15 and defaults to 12. No handset settings were changed by the production app.

The same three-cue preview was listened to at these versions and actual stream levels:

| Main APK | Sample / player gain | Preview level | Listening result |
| --- | --- | --- | --- |
| `b197ab695541dc5e885f86cbd973b9a3cff8c0aa969d5d0fc83b7e96960c5901` | Original -13.16 dBFS WAV / 0.45 | 12/15 | User heard it; at 7/15 the user reported not hearing it. |
| `0a09c06f98d88d45cba2e7b61888d50f58f8b71f9e50c18692badc1148b3a9a5` | -6 dBFS WAV / 1.0 | 7/15 | User heard it but described the sound as quiet. |
| `f7626b8023b09ce1006f65b479265953274caf618512879018835910f90a1ed2` | -1 dBFS WAV / 1.0 | 7/15 | Three nonzero native stream IDs were returned; subjective hearing and level feedback are pending. |

The final preview read back notification and ring streams at 7/15, internal and exposed ringer NORMAL, both streams unmuted, and DND filter ALL during playback. The three `APPROVAL_PENDING` cues spaced about one second apart returned nonzero native stream IDs; user confirmation of hearing the final build and whether its level is satisfactory are both pending. Final handset readback after cleanup was notification/ring 7/15, mute false, internal ringer NORMAL, external ringer SILENT, zen mode 1 / PRIORITY filter, and notification-policy access revoked. Huawei exposes SILENT as a priority-DND proxy; the user-visible ring preference and internal NORMAL state were preserved. See the [three anonymized preview records](issue26-audibility-2026-10-08/) and the [muted-state regression results](issue26-audibility-2026-10-08/muted-regression-summary.txt).

After changing the production sample and gain, the silent-ringer, DND, and zero-volume replay-consumption cases were rerun on the handset: all three passed. These checks use the real player and verify a muted cue does not play again after restoration; a fresh identity plays after unmuting. The final main APK and instrumentation APK both built successfully. JVM tests remained at 190 passed, one expected skip, zero failures; lint had zero errors and 20 baseline warnings. No app pairing data was cleared; the temporary instrumentation package was later uninstalled. This manual fixture is a handset playback check, not a live Claude/Codex upstream test or a recording-based acoustic measurement.

To run the preview explicitly at volume 7 on the connected device:

```sh
adb -P 5038 -d shell am instrument -w \
  -e class com.example.claudephonemonitor.ui.SoundReminderDeviceTest#manualAudibilityPreviewRequiresExplicitOptIn \
  -e issue26_manual_audio notification-preview \
  -e issue26_preview_volume 7 \
  com.example.claudephonemonitor.test/androidx.test.runner.AndroidJUnitRunner
```
