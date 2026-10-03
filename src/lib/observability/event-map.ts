import type { Alarm, AppEvent } from '@/domain';

/**
 * Product analytics events (D12/D20). Coarse, allow-listed properties only: tier, feature
 * flags, mission types, attempt numbers and buckets. Never labels, times, dates, sleep
 * durations, bedtimes, check-in scores or free text.
 */
export type ProductEventName =
  | 'alarm_created'
  | 'alarm_updated'
  | 'mission_started'
  | 'mission_completed'
  | 'mission_failed'
  | 'wake_check_passed'
  | 'wake_check_failed'
  | 'alarm_snoozed'
  | 'paywall_viewed'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_failed'
  | 'purchase_restored';

export type PropertyValue = string | number | boolean;

export interface ProductEvent {
  name: ProductEventName;
  properties: Record<string, PropertyValue>;
}

export type Tier = 'free' | 'pro';

const ALARM_FLAGS = [
  'tier',
  'recurring',
  'repeat_days',
  'sound_kind',
  'vibration',
  'escalation',
  'snooze_enabled',
  'snooze_limit',
  'mission_count',
  'mission_types',
  'mission_before_snooze',
  'wake_check',
  'wake_check_method',
  'important',
] as const;

/** Every property each event may carry. The mapper drops anything else. */
export const ALLOWED_PROPERTIES: Record<ProductEventName, readonly string[]> = {
  alarm_created: ALARM_FLAGS,
  alarm_updated: [...ALARM_FLAGS, 'changed_fields'],
  mission_started: ['tier', 'mission_type', 'step_index'],
  mission_completed: ['tier', 'mission_type', 'step_index'],
  mission_failed: ['tier', 'mission_type', 'step_index', 'reason'],
  wake_check_passed: ['tier', 'attempt'],
  wake_check_failed: ['tier', 'attempt', 'reason'],
  alarm_snoozed: ['tier', 'snooze_count'],
  paywall_viewed: ['tier', 'source'],
  purchase_started: ['tier', 'plan', 'source'],
  purchase_completed: ['tier', 'plan', 'source'],
  purchase_failed: ['tier', 'plan', 'source'],
  purchase_restored: ['tier', 'source'],
};

/** String values must come from these sets (anything else becomes `other`). */
const KNOWN_MISSIONS = ['math', 'shake', 'steps', 'qr'];
const MISSION_FAIL_REASONS = [
  'permission_denied',
  'sensor_unavailable',
  'camera_unavailable',
  'error',
  'abandoned',
];
const WAKE_CHECK_FAIL_REASONS = ['no_response', 'verification_failed'];
const ALARM_FIELDS = [
  'hour',
  'minute',
  'weekdays',
  'date',
  'timezonePolicy',
  'timeZone',
  'label',
  'enabled',
  'sound',
  'vibration',
  'escalation',
  'snooze',
  'skipNext',
  'oneOffOverride',
  'missions',
  'wakeCheck',
  'important',
  'missionBeforeSnooze',
];
/** The paywall's `reason` values (src/features/paywall/copy.ts) plus `other`. */
export const PAYWALL_SOURCES = [
  'advanced-missions',
  'qr-mission',
  'mission-chains',
  'wake-check',
  'insights',
  'ai',
  'sync',
  'settings',
  'other',
] as const;
export const PURCHASE_PLANS = ['monthly', 'annual'] as const;

const known = (allowed: readonly string[], raw: unknown) =>
  typeof raw === 'string' && allowed.includes(raw) ? raw : 'other';

const count = (raw: unknown) =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(99, Math.round(raw))) : 0;

/** 1, 2, 3, 4+ — the exact number is not needed for product decisions. */
const bucket = (raw: unknown) => {
  const n = count(raw);
  return n >= 4 ? '4+' : String(n);
};

/** Keeps only allow-listed keys with primitive values. The single exit for every event. */
export function sanitize(
  name: ProductEventName,
  properties: Record<string, unknown>,
): ProductEvent {
  const allowed = ALLOWED_PROPERTIES[name];
  const clean: Record<string, PropertyValue> = {};
  for (const key of allowed) {
    const raw = properties[key];
    if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') {
      clean[key] = raw;
    }
  }
  return { name, properties: clean };
}

function alarmFlags(alarm: Alarm | null): Record<string, unknown> {
  if (!alarm) return {};
  return {
    recurring: alarm.weekdays.length > 0,
    repeat_days: alarm.weekdays.length,
    sound_kind: known(['default', 'system', 'custom'], alarm.sound.kind),
    vibration: alarm.vibration,
    escalation: alarm.escalation.enabled,
    snooze_enabled: alarm.snooze.enabled && alarm.snooze.maxCount > 0,
    snooze_limit: count(alarm.snooze.maxCount),
    mission_count: alarm.missions.length,
    mission_types: [...new Set(alarm.missions.map((m) => known(KNOWN_MISSIONS, m.missionId)))]
      .sort()
      .join(','),
    mission_before_snooze: alarm.missionBeforeSnooze,
    wake_check: alarm.wakeCheck.enabled,
    wake_check_method: known(['confirm', 'movement', 'mission'], alarm.wakeCheck.method),
    important: alarm.important,
  };
}

export interface MapContext {
  tier: Tier;
  /** The event's alarm as it is now (for feature flags), if it still exists. */
  alarm: Alarm | null;
}

/** Local event (D12) → product event, or null when it is not a product event. Pure. */
export function toProductEvent(event: AppEvent, context: MapContext): ProductEvent | null {
  const tier = context.tier;
  switch (event.type) {
    case 'alarm_created':
      return sanitize('alarm_created', { tier, ...alarmFlags(context.alarm) });
    case 'alarm_updated':
      return sanitize('alarm_updated', {
        tier,
        ...alarmFlags(context.alarm),
        changed_fields: (Array.isArray(event.payload.changed) ? event.payload.changed : [])
          .filter((field) => ALARM_FIELDS.includes(field))
          .sort()
          .join(','),
      });
    case 'mission_started':
    case 'mission_completed':
      return sanitize(event.type, {
        tier,
        mission_type: known(KNOWN_MISSIONS, event.payload.missionId),
        step_index: count(event.payload.stepIndex),
      });
    case 'mission_failed':
      return sanitize('mission_failed', {
        tier,
        mission_type: known(KNOWN_MISSIONS, event.payload.missionId),
        step_index: count(event.payload.stepIndex),
        reason: known(MISSION_FAIL_REASONS, event.payload.reason),
      });
    case 'wake_check_passed':
      return sanitize('wake_check_passed', { tier, attempt: count(event.payload.attempt) });
    case 'wake_check_failed':
      return sanitize('wake_check_failed', {
        tier,
        attempt: count(event.payload.attempt),
        reason: known(WAKE_CHECK_FAIL_REASONS, event.payload.reason),
      });
    case 'alarm_snoozed':
      return sanitize('alarm_snoozed', { tier, snooze_count: bucket(event.payload.snoozesUsed) });
    default:
      return null;
  }
}

export type PaywallEventName = Extract<
  ProductEventName,
  | 'paywall_viewed'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_failed'
  | 'purchase_restored'
>;

export interface PaywallEventProps {
  source?: (typeof PAYWALL_SOURCES)[number];
  plan?: (typeof PURCHASE_PLANS)[number];
}

/** Paywall / purchase event (no prices, ids, receipts or error text). Pure. */
export function paywallEvent(
  name: PaywallEventName,
  props: PaywallEventProps & { tier: Tier },
): ProductEvent {
  return sanitize(name, {
    tier: props.tier,
    source: known(PAYWALL_SOURCES, props.source ?? 'other'),
    plan: props.plan === undefined ? undefined : known(PURCHASE_PLANS, props.plan),
  });
}
