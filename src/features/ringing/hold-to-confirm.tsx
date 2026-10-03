import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

/** How long the stop control must be held. Long enough to never fire by accident. */
export const HOLD_DURATION_MS = 1_500;

/**
 * Deliberate press-and-hold control (no single-tap activation) for stopping an alarm.
 * Fill shows progress; releasing early resets it. VoiceOver/TalkBack users get a named
 * custom action ("activate" alone does nothing, matching the sighted behavior).
 */
export function HoldToConfirm({
  label,
  accessibilityHint,
  onConfirm,
  disabled,
  colors,
}: {
  label: string;
  accessibilityHint: string;
  onConfirm: () => void;
  disabled?: boolean;
  colors: { fill: string; track: string; text: string };
}) {
  const [progress] = useState(() => new Animated.Value(0));
  const [hint, setHint] = useState<string | null>(null);
  const confirmRef = useRef(onConfirm);
  useEffect(() => {
    confirmRef.current = onConfirm;
  }, [onConfirm]);

  const start = () => {
    if (disabled) return;
    setHint(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_DURATION_MS,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      progress.setValue(0);
      confirmRef.current();
    });
  };

  const cancel = () => {
    progress.stopAnimation((value) => {
      if (value < 1) setHint('Keep holding to confirm');
    });
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!disabled }}
        accessibilityActions={[{ name: 'longpress', label }]}
        onAccessibilityAction={(event) => {
          if (!disabled && event.nativeEvent.actionName === 'longpress') onConfirm();
        }}
        disabled={disabled}
        onPressIn={start}
        onPressOut={cancel}
        style={{
          minHeight: 76,
          borderRadius: 38,
          overflow: 'hidden',
          justifyContent: 'center',
          backgroundColor: colors.track,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            backgroundColor: colors.fill,
            width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }}
        />
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' }}>
          {label}
        </Text>
      </Pressable>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: colors.text, opacity: 0.7, fontSize: 15, textAlign: 'center' }}
      >
        {hint ?? ' '}
      </Text>
    </View>
  );
}
