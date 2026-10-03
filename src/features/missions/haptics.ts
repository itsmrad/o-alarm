import * as Haptics from 'expo-haptics';

// Feedback only: a missing haptic engine must never break a wake-up.
const safe = (run: () => Promise<void>) => void run().catch(() => undefined);

export const missionHaptics = {
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  strong: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
