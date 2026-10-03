import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { captureError } from './sentry';

interface State {
  error: Error | null;
}

/**
 * Root error boundary: reports to Sentry (when configured) and shows a calm, honest
 * fallback. Alarms already handed to the system ring regardless of the app UI.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    captureError(error, { boundary: 'root', hasStack: Boolean(info.componentStack) });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <View className="flex-1 justify-center gap-4 bg-background p-6">
        <Text accessibilityRole="header" className="text-title2 text-foreground">
          Something went wrong
        </Text>
        <Text className="text-body text-foreground-muted">
          O-Alarm hit an unexpected problem on this screen. Alarms already scheduled with your phone
          still ring.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => this.setState({ error: null })}
          className="min-h-touch items-center justify-center rounded-control bg-accent px-5 active:opacity-70"
        >
          <Text className="text-headline text-accent-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  }
}
