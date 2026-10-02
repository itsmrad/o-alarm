import { useLocalSearchParams } from 'expo-router';

import { AlarmEditor } from '@/features/alarms/alarm-editor';

export default function EditAlarmRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlarmEditor alarmId={id} />;
}
