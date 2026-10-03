import { Alert, type AlertButton } from 'react-native';

/** Promise wrapper around a two-button Alert. Resolves true on the confirming button. */
export function confirm(
  title: string,
  message: string,
  confirmLabel: string,
  style: AlertButton['style'] = 'destructive',
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
