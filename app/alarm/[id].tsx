import { useLocalSearchParams } from 'expo-router';

import { AlarmEditor } from '@/features/alarms/alarm-editor';
import { parsePrefill } from '@/features/alarms/prefill';

export default function EditAlarmRoute() {
  const { id, ...params } = useLocalSearchParams<{ id: string }>();
  return <AlarmEditor alarmId={id} prefill={parsePrefill(params)} />;
}
