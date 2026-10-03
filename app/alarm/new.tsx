import { useLocalSearchParams } from 'expo-router';

import { AlarmEditor } from '@/features/alarms/alarm-editor';
import { parsePrefill } from '@/features/alarms/prefill';

export default function NewAlarmRoute() {
  const params = useLocalSearchParams();
  return <AlarmEditor prefill={parsePrefill(params)} />;
}
