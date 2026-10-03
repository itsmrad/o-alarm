import { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '@/components/button';
import { codesMatch, type QrConfig } from '@/domain/missions-qr';

import { missionHaptics } from './haptics';
import { CodeScanner } from './qr-scanner';
import { hashCodeValue } from './qr-hash';
import type { MissionViewProps } from './types';

export function QrMission({ config, onComplete, onFail }: MissionViewProps<QrConfig>) {
  const [wrong, setWrong] = useState(false);
  const busy = useRef(false);
  const done = useRef(false);

  const handleScan = async (value: string) => {
    if (busy.current || done.current) return;
    busy.current = true;
    try {
      const hash = await hashCodeValue(value);
      if (codesMatch(config.codeHash, hash)) {
        done.current = true;
        setWrong(false);
        onComplete();
      } else {
        missionHaptics.error();
        setWrong(true);
      }
    } catch {
      onFail('error');
    } finally {
      busy.current = false;
    }
  };

  const where = config.label ? `your “${config.label}” code` : 'your wake-up code';
  return (
    <View className="flex-1 gap-3">
      <Text accessibilityRole="header" className="text-center text-title2 text-foreground">
        Scan {where}
      </Text>
      <CodeScanner
        onScan={(value) => void handleScan(value)}
        hint={wrong ? 'That’s not the registered code. Try again.' : 'Point the camera at the code'}
        deniedActions={
          <Button
            title="Use Math instead"
            size="lg"
            variant="secondary"
            accessibilityHint="Switches this step to a math mission"
            onPress={() => onFail('permission_denied')}
          />
        }
      />
    </View>
  );
}
