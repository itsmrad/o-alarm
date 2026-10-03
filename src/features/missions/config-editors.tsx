import { useState } from 'react';
import { Modal, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { MATH_DIFFICULTIES, type MathConfig } from '@/domain/missions-math';
import { isQrConfigured, type QrConfig } from '@/domain/missions-qr';
import { SHAKE_SENSITIVITIES, type ShakeConfig } from '@/domain/missions-shake';
import type { StepsConfig } from '@/domain/missions-steps';

import { OptionChips } from './option-chips';
import { CodeScanner } from './qr-scanner';
import { hashCodeValue } from './qr-hash';
import type { MissionEditorProps } from './types';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function MathEditor({ config, onChange }: MissionEditorProps<MathConfig>) {
  return (
    <View className="gap-4">
      <OptionChips
        label="Difficulty"
        options={MATH_DIFFICULTIES.map((d) => ({ value: d, label: capitalize(d) }))}
        value={config.difficulty}
        onChange={(difficulty) => onChange({ ...config, difficulty })}
      />
      <OptionChips
        label="Problems"
        options={[1, 3, 5].map((n) => ({ value: n, label: String(n) }))}
        value={config.problemCount}
        onChange={(problemCount) => onChange({ ...config, problemCount })}
      />
    </View>
  );
}

export function ShakeEditor({ config, onChange }: MissionEditorProps<ShakeConfig>) {
  return (
    <View className="gap-4">
      <OptionChips
        label="Shakes"
        options={[10, 20, 30, 50].map((n) => ({ value: n, label: String(n) }))}
        value={config.targetCount}
        onChange={(targetCount) => onChange({ ...config, targetCount })}
      />
      <OptionChips
        label="Sensitivity"
        options={SHAKE_SENSITIVITIES.map((s) => ({ value: s, label: capitalize(s) }))}
        value={config.sensitivity}
        onChange={(sensitivity) => onChange({ ...config, sensitivity })}
      />
    </View>
  );
}

export function StepsEditor({ config, onChange }: MissionEditorProps<StepsConfig>) {
  return (
    <OptionChips
      label="Steps"
      options={[20, 30, 50, 100].map((n) => ({ value: n, label: String(n) }))}
      value={config.targetSteps}
      onChange={(targetSteps) => onChange({ ...config, targetSteps })}
    />
  );
}

export function QrEditor({ config, onChange }: MissionEditorProps<QrConfig>) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registered = isQrConfigured(config);

  const register = async (value: string) => {
    try {
      const codeHash = await hashCodeValue(value);
      onChange({ ...config, codeHash });
      setError(null);
      setScanning(false);
    } catch {
      setError('Could not read that code. Try again.');
    }
  };

  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-footnote uppercase text-foreground-muted">Name (optional)</Text>
        <TextInput
          accessibilityLabel="Code name"
          value={config.label}
          onChangeText={(label) => onChange({ ...config, label })}
          placeholder="e.g. Bathroom mirror"
          maxLength={40}
          className="min-h-touch rounded-control bg-surface-muted px-4 text-body text-foreground"
        />
      </View>
      <Text className="text-callout text-foreground-muted">
        {registered
          ? 'A code is registered. To dismiss the alarm you must scan this exact code. Only a fingerprint of it is stored.'
          : 'Scan any barcode or QR code in your home — put it somewhere you have to walk to, like the bathroom. Only a fingerprint of it is stored.'}
      </Text>
      {error ? <Text className="text-callout text-danger">{error}</Text> : null}
      <Button
        title={registered ? 'Register a different code' : 'Scan code to register'}
        variant={registered ? 'secondary' : 'primary'}
        onPress={() => setScanning(true)}
      />
      <Modal
        visible={scanning}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(false)}
      >
        <View className="flex-1 gap-4 bg-background px-4 pb-8 pt-16">
          <Text accessibilityRole="header" className="text-title2 text-foreground">
            Scan the code to register
          </Text>
          <CodeScanner
            onScan={(value) => void register(value)}
            hint="Point the camera at the code you want to use"
          />
          <Button title="Cancel" variant="secondary" size="lg" onPress={() => setScanning(false)} />
        </View>
      </Modal>
    </View>
  );
}
