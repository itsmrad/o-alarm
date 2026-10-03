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

<!-- PLATFORM SECTIONS: filled in when the Android and iOS implementations merge. -->

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
