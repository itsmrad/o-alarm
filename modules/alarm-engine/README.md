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

iOS 26+ only, **AlarmKit only** (D4): no notification fallback. AlarmKit alarms ring through
Silent mode and Focus, on the lock screen, with the app killed. The only Info.plist key is
`NSAlarmKitUsageDescription` (set by the config plugin; AlarmKit refuses to schedule without
it). No entitlement, background mode or widget extension is needed: the engine has no
countdown presentation, which is the only AlarmKit feature that requires a widget.

### Architecture

```
ios/
  AlarmEngineModule.swift   Expo module: parses args, forwards to the core, maps errors to codes
  AlarmEngineCore.swift     actor: mirror, ringing record, event log, AlarmKit glue, observers
  AlarmEngineIntents.swift  App Intents on the alert: Stop, Open, Snooze (+ AlarmMetadata)
  AlarmEngineModels.swift   wire/persisted types (field names = AlarmEngine.types.ts)
  AlarmEngineStore.swift    JSON file persistence
  AlarmEngineTime.swift     ISO instants, civil dates, D9 wall-clock resolution, id → UUID
```

- **One AlarmKit alarm per schedule id**, always `Alarm.Schedule.fixed(date)`. JS keeps two
  occurrences ahead per alarm (`<alarmId>@<YYYY-MM-DD>`), so a weekly `.relative` schedule per
  occurrence would ring twice; fixed dates can't duplicate. The AlarmKit id is a
  SHA-256-derived UUID of the schedule id, so `schedule` is an upsert: cancel that UUID, then
  schedule it again. Re-scheduling an id never creates a second alarm.
- **Native mirror (D10):** `Application Support/AlarmEngine/state.json` holds every spec
  verbatim (all fields, including `wallClock`) plus `scheduledAt`. It also holds the
  ringing record, the observed-event log and the snooze, wake-check and retrigger counters.
  Writes are atomic with `completeUntilFirstUserAuthentication` protection. If the file is
  unreadable (before the first unlock after a reboot), the engine never overwrites it. Calls
  that need it reject `UNKNOWN`, and readiness shows a warning. A corrupt file is moved aside
  and logged as `schedule_failed` / `mirror_corrupt_reset`.
- **`getScheduled`** cross-checks the mirror with `AlarmManager.alarms`. AlarmKit deletes a
  one-shot alarm after it fires. So an entry that is gone and past its fire time has fired:
  it leaves the list, after its next recurrence is armed. An entry that is gone before its
  fire time is re-armed, or dropped with `schedule_failed` if AlarmKit refuses. An alarm
  that is alerting right now is not listed.
- **Threading:** module calls, App Intents, the `alarmUpdates` observer and the clock
  observers all go through one actor. An async lock serializes them across `await`, so an
  intent racing a JS call can't interleave an upsert.
- **Ringing:** `alarmUpdates` reports `.alerting`. The engine then persists the ringing
  record (`getActiveRinging`), logs `trigger_received` once per ring and emits `onTrigger`
  if JS is listening. A ringing record nobody resolves, and that isn't alerting, expires
  after 2 h.
- **Alert buttons:** Stop is always shown. On 26.1+ the system draws it; on 26.0 it uses the
  deprecated `stopButton` form. The secondary button is **Open** for `hasMissions`,
  `wake_check` and `retrigger`. Otherwise it is **Snooze** while `snooze.enabled` and
  snoozes remain, else nothing. Both are `.custom` App Intents.
- **Intents** run in the app process (AlarmKit launches it in the background if needed), so
  they work with JS dead. Events still go to the log, and to JS when it is alive.
  - *Stop* (system button): logs `stopped_from_system_ui`. If the alarm `hasMissions` or
    `wakeCheck`, it arms `<occurrenceKey>#retrigger-<n>` at now + 1 min, logs `retriggered`,
    keeps the ringing record (the mission is still owed) and emits `onStop
    {missionCompleted: false}`. Otherwise the ring is over (`missionCompleted: true`).
  - *Open*: stops the system alert and keeps or creates the ringing record, so JS routes to
    `/ringing`. It arms a safety retrigger at now + 3 min that `dismiss`/`snooze` cancel.
  - *Snooze*: arms `<occurrenceKey>#snooze-<n>` at now + `durationMin` and stops the alert.
    If the limit was already hit, it re-rings in 1 min instead of going silent.
  - Retriggers are bounded at **5 per occurrence**. When the engine stops an alarm itself
    (in-app dismiss/snooze, Open), it marks the id for 10 min, so a Stop intent the system
    runs for that stop isn't treated as the user's Stop button.
- **`snooze` / `dismiss`** guard `NOT_RINGING`. They accept the ringing id, an id it
  superseded in the same occurrence (a retrigger that fired mid-mission), or any id AlarmKit
  reports as alerting. `snooze` enforces `SNOOZE_LIMIT`. `dismiss` with `wakeCheckAt` arms
  `<occurrenceKey>#wake-check-<n>` first (D13). If that fails, the alarm keeps ringing. Then
  it stops the alert, cancels pending retriggers and resets the counters.
- **Recurrence (D28):** when an `alarm` occurrence rings, the engine arms the next date
  after the alarm's **latest** mirrored `alarm` entry. That happens on alerting, on an intent,
  or when the mirror finds it fired. It uses the same weekdays, time, zone policy and
  `<alarmId>@<YYYY-MM-DD>` id as JS, so reconcile replaces it and never duplicates it. Each
  fired id re-arms once. A failure logs `schedule_failed` with the reason.
- **Floating alarms (D9):** on every module start and on `NSSystemTimeZoneDidChange` or a
  significant time change, the engine recomputes `wallClock.timeZone == null` entries in the
  device zone. It ports `resolveWallClock`: a DST gap fires at the transition instant, an
  overlap at the first occurrence. Each change re-arms the entry and logs
  `tz_change_rescheduled`. An entry that lands in the past logs `missed` and arms the next
  recurrence. Fixed-zone, snooze, wake-check and retrigger instants never move.
- **Event log:** append-only, persisted. `drainObservedEvents` returns the same events until
  `ackObservedEvents` removes them; unknown ids are ignored. Capped at 500, dropping the
  oldest.
- **Preview:** `previewAlarm` arms a real AlarmKit alarm 5 s out under a random UUID. It is
  never listed by `getScheduled` and never retriggers or re-arms.

### Guarantees vs OS limits

- **Stop is not mission-gated (D14).** AlarmKit's Stop always silences the alert. The engine
  can only re-ring (bounded) and keep the mission owed. Diagnostics shows this as a
  `platform_limitation` warning.
- **Vibration, volume and escalation belong to AlarmKit.** `vibration`, `escalation` and
  `important` are stored and round-tripped, but iOS gives no control over haptics, volume
  ramp or loudness. The system alarm behavior applies.
- **Custom sounds:** `sound.kind: 'custom'` plays `AlertSound.named(<id>[.caf|.wav|.aiff|.m4a|.mp3])`
  if the file is in the app bundle or `Library/Sounds`. Otherwise the default sound plays and
  readiness warns ("Custom sound unavailable"). `system` and `default` both use AlarmKit's
  default sound.
- **Floating alarms with the app never running:** iOS doesn't wake the app on a zone change,
  so a fixed-date alarm keeps its instant until O-Alarm next runs. That happens on any launch,
  including one triggered by an alarm intent. It then recomputes and logs
  `tz_change_rescheduled`. The next ring after a zone change can therefore come at the old
  zone's time.
- **Recurrence without the app** relies on the two-ahead buffer plus a native re-arm when a
  ring is seen. That covers alerting while the process is alive, any button intent, or the
  mirror check at the next launch. If both buffered occurrences ring with no button pressed
  and the app never runs, the chain ends after two days.
- **Snooze, wake check and retrigger are real AlarmKit alarms (D13).** They ring with the app
  killed.
- **AlarmKit doesn't expose when a missed alarm (device off) would have fired.** Only
  zone recomputation reports `missed`.

### iOS notes for the device matrix

| # | iOS specifics |
|---|---|
| 1–4 | The AlarmKit alert (full screen when locked, banner when unlocked). Row 3: tapping **Open** must land on `/ringing`. |
| 5, 23 | AlarmKit keeps alarms across reboot/update; no restore event is logged on iOS. Before the first unlock the mirror is unreadable, and Diagnostics shows "Alarm storage locked". |
| 6 | Record what AlarmKit does with a fire time that passed while the phone was off. |
| 8 | `schedule` rejects `PERMISSION_DENIED` when AlarmKit is `denied` or `notDetermined` (and the prompt was refused). Diagnostics shows the blocking `alarms` item. |
| 9, 11, 24 | Android-only. |
| 12 | Killed app: the alarm keeps the old instant until O-Alarm next runs (see above). Opening the app re-arms it and logs `tz_change_rescheduled`. |
| 14 | Recomputation happens natively on launch and on zone/time change. Compare against the JS planner. |
| 19 | The **Snooze** button appears only for alarms without missions. After `maxCount`, the snooze alert has no Snooze button. |
| 21 | Press Stop on a mission alarm: a `retrigger` rings about 1 min later, up to 5 times. Opening the app shows `/ringing`. |
| 22 | Kill the app before the first ring, and press Stop each morning. Check the mirror keeps two future `@date` entries. |
| 25 | The alarm sound is AlarmKit's: it keeps ringing regardless of JS. |

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
