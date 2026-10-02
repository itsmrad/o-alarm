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
