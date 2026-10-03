# PRODUCT.md — Alarm App (source brief)

> Canonical product brief from the product owner. Architecture decisions that refine it live in `docs/DECISIONS.md`.

## Goal

Build a premium alarm + sleep/wake app with one promise:

**Set when you need to wake up. The app makes sure you wake up, learns what works for you, and helps make waking easier over time.**

Boundary: wind down → sleep → alarm → get out of bed → confirm awake → learn → improve.

Do not turn this into a generic wellness, productivity, habit, meditation, or chatbot app.

## Principles

- Alarm reliability is priority #1.
- Existing alarms must work offline and without account/cloud/AI.
- Alarm execution must never depend on Supabase, auth, OpenRouter, RevenueCat, or analytics.
- Wake-critical state is local-first.
- Cloud is for sync, history, AI, billing, and account data.
- Core reliability stays free.
- AI personalizes/explains; deterministic logic handles critical calculations.
- UX should be minimal, calm, polished, fast, and trustworthy.
- Treat sleep/wake data as sensitive.

## Stack

- Mobile: Expo, React Native, TypeScript, Expo Router, EAS, NativeWind
- Native alarms: custom Expo native module
  - iOS: AlarmKit
  - Android: AlarmManager + required receivers/services
- Local: Expo SQLite + SecureStore
- Cloud DB: Supabase PostgreSQL
- Auth: Clerk (see DECISIONS.md)
- AI: OpenRouter, server-side only
- Payments: RevenueCat
- Observability: Sentry
- Analytics: PostHog
- Secrets remain outside the repo.

Auth supports Apple, Google, optional email, and guest/local-only usage. First alarm must work without signup.

RevenueCat entitlement: `pro`. Target pricing: $1.99/month, $14.99/year.

## Critical Architecture Rule

```
create/edit alarm
→ persist locally
→ schedule with native OS
→ verify scheduling
→ update UI
→ sync cloud asynchronously
```

The alarm must still work if internet is unavailable, Supabase is down, auth expires, OpenRouter is down, RevenueCat is down, or analytics is down.

Local DB and native alarm schedules must be safely reconcilable without duplicate alarms.

## MVP

### Alarm

One-time + recurring alarms; multiple alarms; labels; enable/disable; custom sounds where supported; vibration; gradual escalation where supported; snooze + configurable duration + snooze limits; skip next occurrence; temporary one-off time override; next-alarm display; test/preview alarm; offline operation; timezone + DST correctness; reboot recovery; schedule reconciliation after restart.

Handle platform constraints correctly: permissions, exact alarms, notifications, DND / Focus, background restrictions, battery optimization, reboot/timezone changes. **Never silently fail.**

### Reliability

Alarm readiness/diagnostics for: schedule failures, missing permissions, exact-alarm restrictions, notification issues, invalid sound config, local/native mismatches, device/platform limitations.

Track expected vs observed alarm execution. Key events:

```
alarm_created  alarm_updated  alarm_native_scheduled  alarm_schedule_failed
alarm_expected  alarm_trigger_received  alarm_snoozed  alarm_dismissed
mission_started  mission_completed  mission_failed
wake_check_started  wake_check_passed  wake_check_failed  alarm_retriggered
```

Do not claim guarantees the OS cannot provide.

### Wake Missions

MVP: Math, Shake, QR / barcode, Steps / movement, Mission chaining, Wake Check.
Later: Memory, Typing, Squats, NFC, Photo verification, voice/read-aloud.
Keep the mission system extensible without over-engineering it.

### Wake Check

```
alarm → user completes dismissal mission → temporary dismissal → wait configured interval
→ verify user is awake → failure/no response → alarm re-triggers
```

Verification may use confirmation, movement, or a small mission. Persist this state robustly across app/background transitions where supported.

### Anti-Oversleep

Snooze limits; mission before dismiss; optional mission before snooze; Wake Check; mission chains; optional protection against weakening an imminent important alarm. No financial penalties.

### Sleep / Wellbeing (only tightly aligned)

Desired sleep duration; bedtime target; bedtime reminder; wind-down reminder; basic sleep history; morning energy check-in; sleep-quality check-in; optional caffeine cutoff reminder; optional morning light reminder; optional short morning movement reminder; nap mode if it fits naturally.

### AI (MVP)

- **Bedtime Recommendation** — inputs: required wake time, desired sleep duration, sleep latency, historical sleep/wake behavior, morning energy, consistency. Calculate deterministically; AI explains/personalizes.
- **Wake Pattern Insights** — frequent snoozing, returning to sleep after dismissal, ineffective missions, difficult weekdays, short sleep vs morning energy. Never present correlation as medical causation.
- **Mission Recommendation** — which missions/chains correlate with successful waking.
- **Weekly Wake Report** — wake success, snoozes, dismissal time, Wake Check success, sleep consistency, morning energy, 1–2 recommendations.

Pipeline: `events → deterministic/statistical analysis → structured insight → LLM explanation`. AI must never silently change critical alarms.

### Adaptive Wake — Later (NOT MVP)

Design for future modes — Fixed (wake exactly at 07:00), Flexible (~7h30m sleep inside a safe window), Commitment (hard deadline). Future inputs: sleep-onset estimates, HealthKit, Health Connect, wearables, calendar, earliest/latest bounds. For MVP, fixed alarms always win.

### Future Integrations (extension points only)

HealthKit, Health Connect, Apple Watch, Wear OS, Oura, WHOOP, Garmin, Fitbit, calendar-based wake suggestions.

## Account / Sync

install → set alarm → use app, without signup. Accounts unlock cloud sync, history, AI personalization, subscription restore, future multi-device. Support offline edits, delayed sync, guest→account migration, and future multi-device conflicts without risking local alarm execution.

## Data Model

Relational schema around: users, devices, alarms, schedules, alarm occurrences, wake sessions, missions, mission attempts, wake checks, sleep sessions, morning check-ins, preferences, AI insights, entitlements/subscriptions, sync state. Use migrations.

Support analytics: wake success over time, average snoozes, mission effectiveness, Wake Check failure, weekday patterns, sleep duration vs morning energy, bedtime recommendations.

## Free vs Pro

**Free** (genuinely good alarm): normal + recurring alarms, snooze, core reliability, basic missions (Math, Shake, Steps), basic Wake Check, basic bedtime target/reminder.

**Pro**: advanced missions, QR/barcode, mission chains, advanced Wake Check, richer history/analytics, AI bedtime personalization, wake insights, mission recommendations, weekly AI report, cloud sync, advanced personalization, future wearables / adaptive wake.

Never paywall core alarm reliability.

## UX

Minimal, modern, calm, fast, polished, trustworthy. Follow Apple HIG on iOS, Material conventions on Android.

Core screens: Home / next alarm; Create/edit alarm; Ringing alarm; Mission flow; Wake Check; Bedtime; Insights/history; Pro/paywall; Settings; Reliability diagnostics.

Alarm UI must work for a half-awake user: large touch targets, high contrast, no ambiguous controls, no accidental dismissal.

## Privacy / Security

No provider secrets in the client; secure auth; strict DB isolation (RLS); minimize collected data; keep raw sleep history out of generic analytics; support export/delete; never sell sleep/wake data; no ad SDKs; secure token/key storage; no secrets in git.

## Testing

Prioritize alarm reliability. Test recurrence, snooze, missions, Wake Check, timezone/DST, reboot, sync, entitlements, AI structured outputs.

Real-device scenarios: foreground, background, app killed, locked device, reboot, offline, expired auth, Supabase outage, OpenRouter outage, denied permissions, exact-alarm permission revoked, DND/Focus, timezone change, nearby alarms, editing an imminent alarm, snooze + app termination, Wake Check after dismissal.

## Build Priority

1 Foundation · 2 Native alarm engine · 3 Alarm CRUD + ringing UX · 4 Reliability/reconciliation · 5 Missions · 6 Wake Check · 7 Supabase + auth + sync · 8 RevenueCat · 9 Bedtime/sleep · 10 AI personalization · 11 Production hardening.

Do not stop at scaffolding or fake implementations.

## Non-Goals

Financial penalties, gambling/stakes, generic AI chatbot, therapy, meditation library, calorie tracking, general fitness tracking, to-do manager, journaling platform, social feed, broad habit tracker, adaptive sleep-onset wake in MVP.

## Final Standard

Optimize for: **"I trust this app with tomorrow morning."**
