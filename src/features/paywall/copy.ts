/** Why the paywall opened, so it can say what the user was reaching for. */
export type PaywallReason =
  | 'advanced-missions'
  | 'qr-mission'
  | 'mission-chains'
  | 'wake-check'
  | 'insights'
  | 'ai'
  | 'sync'
  | 'settings';

export const REASON_COPY: Record<PaywallReason, string> = {
  'advanced-missions': 'Advanced missions are part of Pro.',
  'qr-mission': 'QR and barcode missions are part of Pro.',
  'mission-chains': 'Mission chains are part of Pro.',
  'wake-check': 'Advanced Wake Check is part of Pro.',
  insights: 'Richer history and insights are part of Pro.',
  ai: 'AI bedtime and wake insights are part of Pro.',
  sync: 'Cloud sync across your devices is part of Pro.',
  settings: 'Support O-Alarm and unlock everything Pro adds.',
};

export function reasonCopy(reason: string | undefined): string | null {
  return reason && reason in REASON_COPY ? REASON_COPY[reason as PaywallReason] : null;
}

/** docs/PRODUCT.md "Free vs Pro". */
export const PRO_FEATURES = [
  'Advanced missions, including QR and barcode',
  'Mission chains',
  'Advanced Wake Check',
  'Richer history and analytics',
  'AI bedtime personalization, wake insights and a weekly report',
  'Cloud sync across your devices',
];

export const RELIABILITY_LINE =
  'Core alarm reliability is always free: alarms, snooze, basic missions and bedtime reminders never need Pro, and your alarms keep ringing even if a subscription lapses.';

export const ROLLOUT_NOTE =
  'Some Pro features are still rolling out; Pro includes them as they ship.';
