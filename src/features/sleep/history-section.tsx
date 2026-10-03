import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Section, Separator } from '@/components/section';
import { deviceTimeZone } from '@/db/alarm-service';
import { nightlySummaries, summarizeSleep } from '@/domain/sleep-stats';
import { localDateInZone, formatLocalDate } from '@/domain/time';

import { describeConsistency, formatDuration, formatNightLabel } from './format';
import { SessionEditor } from './session-editor';
import type { SleepData } from './use-sleep-data';

const BAR_SCALE_MIN = 600; // bars are 10 h wide at minimum so short nights look short

/** Last 14 nights: duration bars against the goal, plus the consistency score. */
export function HistorySection({ data, now }: { data: SleepData; now: Date }) {
  const { service, sessions, checkIns, prefs } = data;
  const timeZone = deviceTimeZone();
  const [editingId, setEditingId] = useState<string | null>(null);

  const nights = nightlySummaries(sessions, { now, timeZone, nights: 14 });
  const summary = summarizeSleep(sessions, checkIns, {
    now,
    timeZone,
    desiredSleepMin: prefs.desiredSleepMin,
  });
  const scale = Math.max(
    BAR_SCALE_MIN,
    prefs.desiredSleepMin,
    ...nights.map((n) => n.durationMin ?? 0),
  );
  const editing = editingId ? sessions.find((s) => s.id === editingId) : undefined;

  const sessionFor = (date: string) =>
    sessions.find(
      (s) => s.endedAt && formatLocalDate(localDateInZone(new Date(s.endedAt), timeZone)) === date,
    );

  return (
    <>
      <Section title="Last 14 nights" footer={describeConsistency(summary.consistencyScore)}>
        <View className="flex-row gap-6 p-4">
          <Stat
            label="Consistency"
            value={summary.consistencyScore === null ? '—' : `${summary.consistencyScore}`}
            unit={summary.consistencyScore === null ? '' : '/ 100'}
          />
          <Stat
            label="Average"
            value={summary.avgDurationMin === null ? '—' : formatDuration(summary.avgDurationMin)}
          />
        </View>
        {summary.nights === 0 ? (
          <>
            <Separator />
            <Text className="p-4 text-callout text-foreground-muted">
              Tap Going to bed tonight and your nights will show up here.
            </Text>
          </>
        ) : (
          nights.map((night) => {
            const session = night.durationMin !== null ? sessionFor(night.date) : undefined;
            const label = `${formatNightLabel(night.date)}, ${
              night.durationMin === null ? 'no data' : formatDuration(night.durationMin)
            }`;
            return (
              <View key={night.date}>
                <Separator />
                <Pressable
                  accessibilityRole={session ? 'button' : 'text'}
                  accessibilityLabel={label}
                  accessibilityHint={session ? 'Edit this night' : undefined}
                  disabled={!session}
                  onPress={() => session && setEditingId(session.id)}
                  className="min-h-touch flex-row items-center gap-3 px-4 py-2 active:bg-surface-muted"
                >
                  <Text className="w-14 text-footnote text-foreground-muted">
                    {formatNightLabel(night.date)}
                  </Text>
                  <View className="h-3 flex-1 rounded-full bg-surface-muted">
                    {night.durationMin !== null ? (
                      <View
                        className={`h-3 rounded-full ${
                          night.durationMin >= prefs.desiredSleepMin ? 'bg-success' : 'bg-accent'
                        }`}
                        style={{ width: `${Math.min(100, (night.durationMin / scale) * 100)}%` }}
                      />
                    ) : null}
                    <View
                      className="absolute -top-0.5 h-4 w-0.5 bg-foreground-muted"
                      style={{ left: `${(prefs.desiredSleepMin / scale) * 100}%` }}
                    />
                  </View>
                  <Text className="w-20 text-right text-footnote text-foreground">
                    {night.durationMin === null ? '—' : formatDuration(night.durationMin)}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </Section>
      {editing ? (
        <SessionEditor
          key={editing.id}
          session={editing}
          service={service}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-footnote uppercase text-foreground-muted">{label}</Text>
      <Text className="text-title2 text-foreground">
        {value}
        {unit ? <Text className="text-callout text-foreground-muted"> {unit}</Text> : null}
      </Text>
    </View>
  );
}
