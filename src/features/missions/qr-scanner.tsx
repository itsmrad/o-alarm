import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { useRef } from 'react';
import { Linking, Text, View } from 'react-native';

import { Button } from '@/components/button';

const BARCODE_TYPES: BarcodeType[] = [
  'qr',
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'code93',
  'itf14',
  'codabar',
  'pdf417',
  'aztec',
  'datamatrix',
];

/**
 * Camera preview that reports every scanned barcode/QR value (any symbology).
 * Handles the permission flow itself and renders an honest message if the camera is
 * denied; `deniedActions` lets the caller add its own way out (e.g. "Switch to Math").
 */
export function CodeScanner({
  onScan,
  deniedActions,
  hint,
}: {
  onScan: (value: string) => void;
  deniedActions?: React.ReactNode;
  hint?: string;
}) {
  // `request: true` asks once on mount; the system dialog is the first thing the user sees.
  const [permission, requestPermission] = useCameraPermissions({ request: true });
  const lastScan = useRef<{ value: string; at: number } | null>(null);

  if (!permission) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-body text-foreground-muted">Starting camera…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    // Still waiting on the system dialog the first time around.
    if (permission.canAskAgain && permission.status === 'undetermined') {
      return (
        <View className="flex-1 items-center justify-center">
          <Text className="text-body text-foreground-muted">Waiting for camera permission…</Text>
        </View>
      );
    }
    return (
      <View className="flex-1 justify-center gap-4">
        <Text accessibilityRole="header" className="text-title2 text-foreground">
          Camera access is off
        </Text>
        <Text className="text-body text-foreground-muted">
          Scanning your code needs the camera. You can allow it in Settings
          {permission.canAskAgain ? ' or try again' : ''}.
        </Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" size="lg" onPress={() => void requestPermission()} />
        ) : (
          <Button title="Open Settings" size="lg" onPress={() => void Linking.openSettings()} />
        )}
        {deniedActions}
      </View>
    );
  }

  return (
    <View className="flex-1 gap-3">
      <View className="flex-1 overflow-hidden rounded-card bg-surface-muted">
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={({ data }) => {
            const now = Date.now();
            const last = lastScan.current;
            // The camera reports the same code many times a second.
            if (last && last.value === data && now - last.at < 1500) return;
            lastScan.current = { value: data, at: now };
            onScan(data);
          }}
        />
      </View>
      {hint ? <Text className="text-center text-headline text-foreground">{hint}</Text> : null}
    </View>
  );
}
