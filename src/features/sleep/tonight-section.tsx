import { useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ClockText } from '@/components/clock-text';
import { deviceTimeZone } from '@/db/alarm-service';
import type { Alarm } from '@/domain';
import { recommendBedtime, upcomingWakeTargets } from '@/domain/sleep';
import { recentBedtimes } from '@/domain/sleep-stats';
import { wallClockInZone } from '@/domain/time';
import { formatCountdown, formatRelativeDay } from '@/features/alarms/format';

import { describeRationale, formatDuration, formatTime } from './format';
import { SessionEditor } from './session-editor';
import type { SleepData } from './use-sleep-data';

/** Tonight's recommended bedtime + wind-down, and the "Going to bed" / "I'm awake" action. */
export function TonightSection({
  data,
  alarms,
  now,
}: {
  data: SleepData;
  alarms: readonly Alarm[];
  now: Date;
}) {
  const { service, prefs, sessions, active } = data;
  const timeZone = deviceTimeZone();
  const [editing, setEditing] = useState(false);

  if (active) {
    const start = new Date(active.startedAt);
    return (
      <>
        <View className="gap-3 rounded-card bg-surface p-5" accessibilityRole="summary">
          <Text className="text-footnote font-semibold uppercase text-foreground-muted">
            Sleeping
          </Text>
          <Text className="text-title2 text-foreground">Since {formatTime(start, timeZone)}</Text>
          <Text className="text-callout text-foreground-muted">
            {formatDuration(Math.max(0, (now.getTime() - start.getTime()) / 60_000))} so far.
            Dismissing your alarm ends this automatically.
          </Text>
          <Button
            title="I'm awake"
            size="lg"
            onPress={() => {
              const ended = service.endActiveSleepSession(new Date());
              if (!ended) {
                Alert.alert(
                  'Not recorded',
                  'That session ran too long to be a single night, so it was discarded.',
                );
              }
            }}
          />
          <Button title="Adjust times" variant="secondary" onPress={() => setEditing(true)} />
        </View>
        {editing ? (
          <SessionEditor session={active} service={service} onClose={() => setEditing(false)} />
        ) : null}
      </>
    );
  }

  const target = upcomingWakeTargets(alarms, now, timeZone, 1)[0];
  const rec = recommendBedtime({
    now,
    timeZone,
    prefs,
    wake: target?.fireAt ?? null,
    recentBedtimes: recentBedtimes(sessions),
  });
  const goingToBed = (
    <Button
      title="Going to bed"
      size="lg"
      accessibilityHint="Starts tracking tonight's sleep"
      onPress={() => service.startSleepSession(new Date())}
    />
  );

  return (
    <View className="gap-3 rounded-card bg-surface p-5">
      <Text className="text-footnote font-semibold uppercase text-foreground-muted">
        {prefs.mode === 'manual' ? 'Your bedtime' : "Tonight's bedtime"}
      </Text>
      {rec.bedtime && rec.windDownAt ? (
        <>
          <View accessible accessibilityLabel={`Bedtime ${formatTime(rec.bedtime, timeZone)}`}>
            <ClockText
              hour={wallClockInZone(rec.bedtime, timeZone).hour}
              minute={wallClockInZone(rec.bedtime, timeZone).minute}
              size="display"
            />
          </View>
          <Text className="text-headline text-foreground">
            {formatRelativeDay(rec.bedtime, now, timeZone)} ·{' '}
            {formatCountdown(rec.bedtime.getTime() - now.getTime())}
          </Text>
          {prefs.windDownMin > 0 ? (
            <Text className="text-callout text-foreground-muted">
              Wind down from {formatTime(rec.windDownAt, timeZone)}
            </Text>
          ) : null}
        </>
      ) : (
        <Text className="py-2 text-title2 text-foreground">No alarm to plan around</Text>
      )}
      <View className="gap-1 pb-1">
        {rec.rationale.map((code) => (
          <Text key={code} className="text-footnote text-foreground-muted">
            {describeRationale(code, rec, prefs, timeZone)}
          </Text>
        ))}
      </View>
      {goingToBed}
    </View>
  );
}
