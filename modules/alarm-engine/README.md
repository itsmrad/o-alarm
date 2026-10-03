# alarm-engine — O-Alarm native alarm engine

The local Expo native module behind the `AlarmEngine` TS contract (`src/engine/types.ts`).
iOS uses **AlarmKit** (iOS 26+, D4). Android uses **AlarmManager.setAlarmClock** with a
foreground ringing service (D5). In Expo Go the app falls back to the in-memory
`PreviewAlarmEngine` (D6), which never rings.

Product bar: *"I trust this app with tomorrow morning."* This README lists what the engine
guarantees, what the OS can still prevent, and how to prove both on real devices.

## Layout

```
modules/alarm-engine/
  index.ts, src/                  TS wire types + module declaration (contract; owned with src/engine)
  app.plugin.js, plugin/          config plugin (CNG — never edit ios/ or android/)
  android/                        Kotlin engine, receivers, ringing service, JVM tests
  ios/                            Swift AlarmKit engine, App Intents
```

`src/engine/native-engine.ts` adapts the module to `AlarmEngine` and turns every native
rejection into a typed `AlarmEngineError` (`AlarmEngineError.from`).

## Contract (both platforms)

| Call | Behavior |
|---|---|
| `schedule(spec)` | Idempotent upsert keyed by `spec.id`: replaces, never duplicates. Validates the spec (`INVALID_SPEC`), checks permission (`PERMISSION_DENIED`), and maps OS errors to `SCHEDULE_FAILED`. Persists the spec verbatim in the native mirror (D10) and returns it with `scheduledAt`. |
| `cancel(id)` / `cancelAll()` | Idempotent. Removes the OS alarm and the mirror entry. |
| `getScheduled()` | What is really armed: the mirror cross-checked against OS state. A fired alarm leaves this list. |
| `getReadiness()` | Honest readiness items. `canRing` is false if any item is `blocking`. |
| `requestPermission(kind)` | Runtime request or the right Settings screen. Kinds that don't apply on the platform return `unavailable`. |
| `previewAlarm(spec)` | Rings now through the real ringing path. Not stored as a schedule. |
| `getActiveRinging()` | The ringing alarm, persisted natively so a cold start while ringing can route to `/ringing`. |
| `snooze(id)` | `NOT_RINGING` / `SNOOZE_LIMIT` guarded. Arms `<occurrenceKey>#snooze-<n>` at now + duration. |
| `dismiss(id, {missionCompleted, wakeCheckAt?})` | Stops ringing. With `wakeCheckAt`, it first arms `<occurrenceKey>#wake-check-<n>` natively (D13), so a bad instant leaves the alarm ringing. |
| `drainObservedEvents()` / `ackObservedEvents(ids)` | Native-observed event log: what happened while JS may have been dead. Drain repeats until ack. |

Every native error maps to an `AlarmEngineErrorCode`: `PERMISSION_DENIED`, `INVALID_SPEC`,
`SCHEDULE_FAILED`, `SNOOZE_LIMIT`, `NOT_RINGING`, `NOT_IMPLEMENTED` or `UNKNOWN`. Nothing
fails silently.

## Android

### Architecture

```
android/src/main/java/com/oalarm/alarmengine/
  AlarmEngineModule.kt      Expo bridge; maps every failure to a typed CodedException
  AlarmEngineCore.kt        platform-free logic: upsert, ring queue, snooze, dismiss, restore, recurrence
  AlarmModel.kt             AlarmSpec / RingingRecord / ObservedEvent + JSON and bridge-map codecs
  AlarmStore.kt             native mirror: one JSON file, atomic replace
  Recurrence.kt             D9 wall-clock rules (DST gap → transition instant, overlap → first)
  AndroidAlarmScheduler.kt  AlarmManager.setAlarmClock, one PendingIntent per schedule id
  AlarmReceivers.kt         fire, boot/time/tz/upgrade/permission restore, notification actions
  RingingService.kt         foreground ringing: sound, vibration, escalation, full-screen intent
  AlarmEnginePackage.kt     shows the RN activity over the lock screen only while ringing
  Readiness.kt              diagnostics + settings intents
  Engine.kt                 process-wide singleton over device-protected storage
android/src/test/…          JVM tests (store, recurrence, core)
```

**Mirror (D10).** Every scheduled spec is stored verbatim (all fields, incl. `wallClock`) in
`noBackupFilesDir/alarm-engine/state.json` of the *device-protected* storage context, so
`LOCKED_BOOT_COMPLETED` can read it before the first unlock and it is never restored from a
backup onto another device. The same file holds the ringing alarm, the ring queue, snooze /
wake-check counters and the observed-event log (capped at 500, drained until acked). Writes
go to a temp file then an atomic rename. An unreadable file is renamed `.corrupt`, the engine
starts empty and logs `schedule_failed` (`native mirror unreadable`); JS reconcile re-schedules.

**Scheduling.** `setAlarmClock` (exact, Doze-exempt, status-bar alarm icon). Each id gets its
own broadcast PendingIntent keyed by the data URI `oalarm-engine://schedule/<id>`, so an
upsert replaces the OS alarm and ids never collide. `getScheduled()` returns mirror entries
whose PendingIntent still exists, and nothing at all while exact-alarm access is revoked, so
JS reconcile sees the truth and its re-schedule surfaces `PERMISSION_DENIED`.

**Recompute without JS — choice: store the wall-clock rule.** The mirror keeps both the fire
instant and the D28 `wallClock`. On `TIMEZONE_CHANGED` / `TIME_SET` / boot / upgrade /
exact-alarm re-grant (and on every app start) `restore()`:

1. recomputes floating `alarm` entries (`wallClock.timeZone == null`) as `hour:minute` on
   `localDate` in the new device zone (D9 DST rules) and logs `tz_change_rescheduled`;
   fixed-zone alarms and instant-only kinds (snooze / wake_check / retrigger) keep their instant;
2. rings an instant that passed less than 10 min ago now; older ones are logged `missed`;
3. re-arms everything else (`schedule_restored_after_boot` for boot/upgrade/permission), and
   logs `schedule_failed` with the error code for anything the OS refuses.

**Recurrence (D28).** When an `alarm` occurrence rings (or is missed), native arms the
occurrence after the alarm's *latest* mirrored one with the JS id format `<alarmId>@<date>`.
JS schedules 2 ahead, so a daily alarm keeps 2 armed and keeps ringing if the app is never
opened. JS reconcile stays authoritative (skip-next, overrides) and replaces by id.

**Ringing.** The fire receiver moves the entry from the mirror to the persisted ringing record
and starts `RingingService` (`mediaPlayback` FGS; the alarm-clock exemption allows the start
from the background). The service plays `USAGE_ALARM` audio: custom sound (a bundled
`res/raw` name, a file path or a URI) → system sound URI → default alarm → generated tone, so
it is never silent. Escalation ramps player volume 15 % → 100 % of the alarm stream over
`rampSeconds`; vibration uses the alarm vibration usage. It holds a partial wake lock and
requests transient audio focus. Its notification (category ALARM) carries a full-screen
intent: `ACTION_VIEW oalarm://ringing?alarmId=…&occurrenceKey=…&scheduleId=…` to the launch
activity, which Expo Router maps to `app/ringing.tsx` (cold and warm start). The activity is
shown over the lock screen and turns the screen on **only while ringing**. If the user swipes
the notification away (Android 14+), it is reposted. The service is `START_STICKY` and reads
the ring from the mirror, so it keeps ringing when JS dies or the process is restarted, and it
stops only via `dismiss` / `snooze`. A ring interrupted by reboot resumes within 1 h. An alarm
that fires while another rings is queued and rings right after; nothing is dropped.

**System-UI actions.** The notification offers *Snooze* only when the alarm has no mission and
snoozes remain, and *Dismiss* only without mission and Wake Check, so the notification can't
bypass either (D13). Mission alarms show *Open O-Alarm to complete your mission*.

**Snooze / Wake Check (D13).** `snooze` arms `<occurrenceKey>#snooze-<n>` (instant-only) before
stopping; the per-occurrence count survives process death and enforces `SNOOZE_LIMIT`.
`dismiss` with `wakeCheckAt` arms `<occurrenceKey>#wake-check-<n>` first; a bad instant
rejects `INVALID_SPEC` and the alarm keeps ringing.

**Permissions / readiness.** `USE_EXACT_ALARM` (API 33+, alarm-clock apps) with
`SCHEDULE_EXACT_ALARM` (≤ 32), `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`,
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `VIBRATE`.
Readiness items: exact alarm (**blocking** when denied), notifications and full-screen intent
(Android 14+) (warning: it still rings, but no lock-screen UI), battery optimization (warning),
alarm volume 0 (warning), OEM background-killer hint (Xiaomi, Huawei, Samsung, OnePlus, Oppo,
Vivo, Meizu, Asus), and a note that force stop cancels alarms. `requestPermission` uses the
runtime dialog for notifications and the matching Settings screen for exact alarm, full-screen
intent and battery optimization (it resolves the current status; JS re-checks on foreground).
`alarms` is AlarmKit-only → `unavailable`.

### Guarantees vs OS limits (Android)

| Guaranteed by the engine | Up to the OS / user |
|---|---|
| Exact, Doze-exempt alarms while "Alarms & reminders" is allowed | Revoking it cancels all exact alarms; readiness goes blocking, re-grant re-arms without the app |
| Restore after reboot before first unlock, time/tz change, app update — no JS | **Force stop** cancels everything until the app is opened again |
| Alarm-stream audio that falls back to a tone, never silent by code | Alarm volume 0 or an OEM audio policy can still mute it (readiness warns on volume 0) |
| Ringing survives JS death / process restart until dismiss or snooze | OEM killers (dontkillmyapp.com) can kill the service; readiness shows a hint |
| Lock-screen ringing UI via full-screen intent | Needs notifications and, on 14+, full-screen-intent access; otherwise a heads-up notification |
| Recurring alarms keep ringing without the app (2 ahead + native re-arm) | Skip-next / overrides need JS to have run once after the edit |
| Missed alarms are reported (`missed`), never silently dropped | A device powered off at fire time cannot ring |

Before the first unlock after a reboot the RN activity can't start (credential storage is
locked): the alarm still rings with its notification; mission alarms need an unlock to open
the ringing screen. Device test row 5 must confirm the app's `Application.onCreate` (Expo
modules) tolerates direct boot.

### Build & test (Linux, D7)

```sh
source ~/Android/env.sh                     # JDK 17 + ~/Android/Sdk (user space)
npx expo prebuild --platform android --clean
cd android && oalarm-heavy ./gradlew :app:assembleDebug
oalarm-heavy ./gradlew :alarm-engine:testDebugUnitTest   # JVM tests, no device
```

Custom sounds: put the file in the app's `res/raw` (e.g. via a config plugin) and pass its
resource name as `sound.id`; anything unresolvable falls back to the default alarm sound.

## iOS

<!-- IOS: owned by the iOS implementation. -->

## Real-device test matrix

Run on at least one Pixel (stock Android 14+), one OEM-skinned Android (Samsung, Xiaomi or
OnePlus) and one iPhone on iOS 26+. Use an EAS **development** build (`eas build --profile
development`), never Expo Go. Before each run, check Settings → Diagnostics shows the engine
as `native` with no blocking items, unless the row says otherwise.

For each row, record: device / OS, pass / fail, the observed event log (Diagnostics), notes.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | Foreground | App open, alarm in 2 min | Rings on time with the ringing screen, sound, vibration and escalation. `trigger_received` logged. |
| 2 | Background | Alarm in 2 min, app backgrounded | Rings on time. Android: full-screen ringing UI. iOS: AlarmKit alert. |
| 3 | Killed | Alarm in 2 min, swipe the app away | Rings on time. Opening from the alert routes to `/ringing` (`getActiveRinging`). |
| 4 | Locked | Alarm in 2 min, lock the screen | Android: the screen turns on with the ringing UI over the lock screen. iOS: AlarmKit lock-screen alert. |
| 5 | Reboot | Alarm in 10 min, reboot, **don't unlock** for 5 min | Android: restored from `LOCKED_BOOT_COMPLETED` before unlock; `schedule_restored_after_boot` logged. iOS: AlarmKit keeps the alarm. |
| 6 | Reboot across fire time | Alarm in 3 min, power off 5 min, power on | Android: rings ASAP if it's within the 10-min grace, otherwise logged as missed. iOS: system behavior is recorded. |
| 7 | Offline | Airplane mode, alarm in 2 min | Rings. No network is involved anywhere on the ring path. |
| 8 | Permissions denied | Deny AlarmKit (iOS) / notifications + exact alarm (Android) | `schedule` rejects `PERMISSION_DENIED`, Diagnostics shows a blocking item with an action, and nothing pretends to be scheduled. |
| 9 | Permission revoked | Android: revoke "Alarms & reminders" with alarms set, then re-grant | Revoke: Diagnostics goes blocking. Re-grant: `SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED` re-arms the mirror without opening the app. |
| 10 | DND / Focus / Silent | Enable DND (Android) or a Focus and the Silent switch (iOS), alarm in 2 min | Rings audibly. AlarmKit and the Android alarm stream bypass DND for alarms. Record any OEM deviation. |
| 11 | Alarm volume 0 (Android) | Set the alarm stream volume to 0 | Diagnostics warns before the alarm. Record the ring behavior. |
| 12 | Time-zone change | Floating 07:00 alarm. Change the zone manually with the app killed | It re-arms at 07:00 in the new zone without opening the app; `tz_change_rescheduled` logged. Fixed-zone alarm: instant unchanged. |
| 13 | Manual time change | Move the clock forward / back with the app killed | Alarms keep their instants. A missed one is reported. |
| 14 | DST | Floating alarm inside a DST gap / overlap (set the device date near a transition) | Gap: fires at the transition instant. Overlap: fires at the first occurrence (D9). |
| 15 | Nearby alarms | Two alarms 1 min apart, and two at the same minute | Both ring in order. The second waits or takes over without losing the first's state. Nothing is dropped. |
| 16 | Edit imminent alarm | Alarm in 1 min. Change it to +3 min | Rings once at the new time. The old instant does not ring (upsert, no duplicate). |
| 17 | Delete imminent alarm | Alarm in 1 min, delete it | Doesn't ring. |
| 18 | Snooze + kill | Snooze, swipe the app away | The snooze re-rings after the duration. The limit is enforced (`SNOOZE_LIMIT`) after maxCount. |
| 19 | Snooze from the system UI | Android: notification Snooze action. iOS: alert Snooze button | Same as 18, with `snoozed` logged. |
| 20 | Wake Check after dismissal | Alarm with Wake Check. Complete the mission, dismiss, kill the app | The wake-check alarm rings at `wakeCheckAt` even though the app is killed. |
| 21 | Stop without mission (iOS) | Mission alarm. Press the system **Stop** | A follow-up retrigger alarm rings; `stopped_from_system_ui` + `retriggered` logged (D14). |
| 22 | Recurring without app | Daily alarm. Don't open the app for 3 days | It rings every day. Native arms the next occurrence after each ring (D28). |
| 23 | App update | Install a new build with alarms set | Android: `MY_PACKAGE_REPLACED` re-arms everything. iOS: alarms persist. |
| 24 | Battery saver / OEM killer | Android with battery optimization on and the OEM's "deep sleep" enabled | Record the result. Diagnostics shows the OEM hint. |
| 25 | Ringing survives JS death | While ringing, force-stop JS (dev menu reload / kill) | Sound continues until dismiss or snooze. |
