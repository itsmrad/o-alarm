import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { PreviewBanner } from './preview-banner';

/** Standard scrolling screen body: background, padding, persistent preview banner. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  if (!scroll) {
    return (
      <View className="flex-1 gap-4 bg-background px-4 pb-8 pt-4">
        <PreviewBanner />
        {children}
      </View>
    );
  }
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-4 pb-12 pt-4"
      keyboardShouldPersistTaps="handled"
    >
      <PreviewBanner />
      {children}
    </ScrollView>
  );
}
