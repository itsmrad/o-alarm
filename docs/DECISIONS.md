# DECISIONS.md — Architecture Decisions

Binding for every agent. Change only via the orchestrator. Product brief: `docs/PRODUCT.md`.

## Platform & tooling

| # | Decision | Why |
|---|---|---|
| D1 | **Expo SDK: latest stable**, New Architecture, Expo Router (typed routes), TypeScript strict. | Expo Go on the owner's devices only runs the latest SDK. |
| D2 | **Package manager: npm.** Single app at repo root. `supabase/` for backend, `modules/alarm-engine/` for the local Expo native module. No monorepo tooling. | Fewest moving parts with EAS. |
| D3 | **Styling: NativeWind** (Tailwind) with a semantic token theme (light/dark), plus `@expo/ui` / native components where they beat custom UI (pickers, switches, menus). Follow Apple HIG on iOS. | Owner requirement. |
| D4 | **iOS minimum: iOS 26.** iOS alarms use **AlarmKit only**. No notification-based fallback. | Only AlarmKit rings through silent/Focus. Reliability > reach. |
| D5 | **Android: minSdk 26, target latest.** `AlarmManager.setAlarmClock()` (exact, Doze-exempt, status-bar icon), full-screen-intent ringing Activity + foreground service (`mediaPlayback`/`systemExempted` as appropriate), receivers for `BOOT_COMPLETED`, `LOCKED_BOOT_COMPLETED` (direct-boot aware storage), `TIME_SET`, `TIMEZONE_CHANGED`, `MY_PACKAGE_REPLACED`, `SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`. Request `USE_EXACT_ALARM` (alarm-clock app category) with `SCHEDULE_EXACT_ALARM` fallback. | Current platform-correct alarm-clock pattern. |
| D6 | **Expo Go preview mode.** The app must boot and be fully navigable in Expo Go. When the native module is unavailable (`Constants.executionEnvironment === 'storeClient'` or module missing), the engine resolves to a `PreviewAlarmEngine` (JS mock) and the UI shows a persistent, honest "Preview mode — alarms will not ring. Install the development build." banner. Real alarm behavior requires an EAS development build. | Owner previews on physical devices via Expo Go; we must never imply a preview alarm will ring. |
| D7 | Local machine is Linux: **iOS native code is verified via EAS Build** (cloud). Android native is verified locally with Android SDK + JDK 17 installed in user space (mise / `~/Android/Sdk`), no sudo. | No Xcode on Linux. |

## Data & reliability

| # | Decision |
|---|---|
| D8 | **Local DB: expo-sqlite + Drizzle ORM** with versioned migrations (drizzle-kit generated, bundled). SQLite is the source of truth for alarms on device. SecureStore only for tokens/keys. |
| D9 | **Time model:** alarms store *wall-clock* time (`hour`, `minute`, `weekdays[]`, optional `date` for one-time) + `timezonePolicy: 'floating'` (follows device tz; default) or `'fixed'` with an IANA zone. A pure, deterministic TS function computes the next fire instant(s) — fully unit-tested across DST gaps/overlaps and tz changes. Library: `date-fns` + `@date-fns/tz`. DST gap rule: fire at the first valid instant after the gap. Overlap rule: fire at the first occurrence. |
| D10 | **Native owns a mirror.** The native layer persists every scheduled alarm (id, fire instant, payload, sound, snooze config) in native storage so reboot/tz/upgrade recovery works **without JS running**. JS reconciles DB ↔ native on every app start, foreground, and tz-change event, keyed by a stable `alarmId` + `occurrenceKey` → idempotent, never duplicates. |
| D11 | **Write path:** persist locally → schedule natively → read back & verify → update UI → enqueue sync (outbox). A schedule failure is surfaced in UI + diagnostics and logged as `alarm_schedule_failed`; never silent. |
| D12 | **Event log:** local append-only `events` table with the key events from PRODUCT.md (typed union). Analytics/cloud consume from it; raw sleep data never goes to PostHog. |
| D13 | **Wake Check & snooze re-triggers are native alarms**, scheduled at dismissal/snooze time, so they fire even if the app is killed. Cancelled only on explicit pass. |
| D14 | **iOS caveat:** AlarmKit's system Stop button cannot be fully mission-gated. Best available: the stop action runs an App Intent that, if the mission/Wake Check was not completed in-app, schedules a follow-up alarm. Diagnostics/UX must state this limitation honestly. |

## Cloud, account, money

| # | Decision | Why |
|---|---|---|
| D15 | **Auth: Clerk** (`@clerk/clerk-expo`), Apple + Google + email code; guest = no Clerk session, fully functional locally. | Mature Expo SDK + native Supabase third-party-auth integration; no auth server to run. |
| D16 | **Supabase**: Postgres with migrations in `supabase/migrations`, **RLS on every table** keyed on `auth.jwt()->>'sub'` (Clerk user id) via Supabase's Clerk third-party auth. Edge Functions (Deno) for OpenRouter + RevenueCat webhooks. | Strict isolation, no service keys in client. |
| D17 | **Sync**: local outbox + per-row `updated_at`/`version`, last-writer-wins per row for MVP, device id on every write; guest→account migration uploads local history once. Sync never blocks or mutates native schedules directly — it writes to SQLite, then the normal reconcile path schedules. |
| D18 | **RevenueCat** (`react-native-purchases`), entitlement `pro`, offerings $1.99/mo, $14.99/yr. Entitlement cached locally; missing/unknown entitlement never disables an existing alarm (Pro-only features degrade to the free equivalent at ring time). |
| D19 | **AI**: OpenRouter called only from a Supabase Edge Function. Client sends computed, structured stats (not raw history); LLM returns schema-validated JSON (zod). Deterministic bedtime math lives in TS (`src/features/sleep/bedtime.ts`). AI never edits alarms; it may only suggest. |
| D20 | **Observability**: Sentry (`@sentry/react-native`) + PostHog (`posthog-react-native`), both no-op without keys and never on the ring path's critical section. |
| D21 | **Secrets**: `.env` (gitignored) + EAS secrets; only `EXPO_PUBLIC_*` publishable keys in the client. |

## Code layout (target)

```
app/                      Expo Router routes (thin)
src/features/<feature>/   alarms, ringing, missions, wakecheck, sleep, insights, account, paywall, diagnostics
src/domain/               pure types + logic (recurrence, snooze, mission chain, wake-check state machine)
src/db/                   drizzle schema, migrations, repositories
src/engine/               AlarmEngine TS contract + Native/Preview implementations + reconciler
src/lib/                  analytics, sentry, sync, auth glue
modules/alarm-engine/     Expo native module (ios/ Swift AlarmKit, android/ Kotlin)
supabase/                 migrations, functions
```

## Addenda

| # | Decision |
|---|---|
| D22 | **Pro gating of cloud sync is enforced server-side on writes** (RLS `WITH CHECK` via a `has_entitlement('pro')` helper reading the service-role-managed `entitlements` table) — implemented with the sync task. Reads, `export_my_data()` and `delete_my_data()` stay allowed for every signed-in user, so a lapsed subscriber never loses access to their own data. Guest→account migration upload is allowed once regardless of tier (local history stays on device either way). |
| D23 | `alarm_schedules` is folded into `alarms` (recurrence lives on the alarm row; occurrences are separate) — accepted from the cloud-schema worker. |
| D24 | iOS 26 target is set via `ios.deploymentTarget` in app.config.ts (expo-build-properties' iOS key is deprecated in SDK 56+); Android minSdk 26 stays in expo-build-properties. Expo SDK 57 / RN 0.86. |
| D25 | The **sync task owns the local↔cloud field mapping** (weekdays 0=Sun local vs ISO 1–7 cloud, skipNext/oneOffOverride via occurrenceKey vs skip_date/override_*, sound object vs text, escalation vs gradual_volume, snooze maxCount vs snooze_limit, important / wakeCheck.responseWindow / maxRetriggers, label length 60 local). It adds a cloud migration to close gaps; **the local domain model is the source of truth.** |
| D26 | `alarm_deleted` is part of the event union; the cloud `events` check constraint must include it (sync task migration). |
| D27 | Shared native deps are installed once on `mvp` by the orchestrator: expo-dev-client, expo-sensors, expo-camera, expo-audio, expo-keep-awake. Children that need a NEW dependency ask the orchestrator instead of editing package.json. |
| D28 | `AlarmScheduleSpec.wallClock?` `{ hour, minute, localDate, timeZone \| null (null = floating), weekdays (0=Sun; empty = one-time) }` on kind `'alarm'` only. Native recomputes floating alarms on tz/time change (D9 rules) and arms the next recurring occurrence itself after a ring when JS never runs. JS reconcile stays authoritative (skip-next/override) and replaces native-armed occurrences by schedule id — never duplicates. iOS prefers AlarmKit's weekly relative schedule where it maps cleanly. |
| D29 | ObservedEngineEventType adds `missed` and `schedule_failed` (+ optional `detail`). JS maps missed → occurrence outcome `missed` (surfaced on Home + Diagnostics), schedule_failed → `alarm_schedule_failed` + blocking diagnostics item. |
| D30 | Wave-3 shared deps installed on `mvp` by the orchestrator: expo-notifications (bedtime/wind-down/check-in reminders only — never alarms on iOS), expo-secure-store, expo-web-browser, expo-auth-session, expo-apple-authentication, **@clerk/expo** (Core 3; `@clerk/clerk-expo` is deprecated), @supabase/supabase-js, react-native-purchases(+ui). Plugins + `ios.usesAppleSignIn` configured. |
| D31 | **Schema ownership:** only the task that owns `src/db/**` may add local migrations at a time (drizzle journal is a hot file). Other tasks use existing tables (`sleep_sessions`, `morning_checkins`, `preferences`, `outbox`, `sync_state`, `device`) or ask the orchestrator. |
| D32 | `alarm.missionBeforeSnooze: boolean` (default false) in the local domain model + local column (ringing task), mapped to the cloud column `mission_before_snooze` (account-sync task). |
| D33 | **Machine safety (owner machine: 12 cores / 15 GB; crashed twice).** All heavy commands run through `oalarm-heavy` (global flock → one heavy job at a time, nice/ionice, systemd scope MemoryMax 4G, CPU 400%). Orca daemon scope capped via `oalarm-limits` (MemoryHigh 6.5G / Max 8G / CPU 900%) — re-run after reboot/Orca restart. Max 4 live agents total; SUBs max 1 child. No watchers/dev servers in workers; Supabase start→test→stop in one invocation. |
| D34 | `oalarm-heavy` has two lanes: **js** (jest/tsc/eslint/expo export; 3G, 3 cores) and **native** (gradle/prebuild/supabase; 5G, 5 cores), each serialized, running in parallel with each other. Orca scope cap raised to 6G/7G. Local Android verification builds use a single ABI (`-PreactNativeArchitectures=arm64-v8a`). Supersedes the single-lock part of D33. |
| D35 | **Single SQLite connection.** Only AppServices boot() calls `openAppDatabase()` (and runs migrations). Every feature takes `db`/`deviceId` from AppServices (`useAppServices()`) or by injection — a second connection races migrations on first launch and risks SQLITE_BUSY on the alarm save path. |
| D36 | `oalarm-heavy` enforces hard per-job timeouts (js 20m, native 60m). jest always runs with `--forceExit` (a finished-but-hung jest held the shared lock 14 min). Tests must tear down timers/handles. |
