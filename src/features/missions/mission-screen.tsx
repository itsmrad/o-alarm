import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { NativeSwitch } from '@/components/native-switch';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import type { MissionAttemptResult, MissionStep } from '@/domain/missions';
import type { MissionChainEvent } from '@/domain/missions-chain';

import { MissionChainEditor } from './mission-chain-editor';
import { MissionChainRunner } from './mission-chain-runner';

type Run =
  | { status: 'idle' }
  | { status: 'running'; id: number }
  | { status: 'finished'; outcome: 'completed' | 'left'; attempts: MissionAttemptResult[] };

const describeEvent = (e: MissionChainEvent) =>
  `${e.type} · ${Object.entries(e.payload)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`;

/**
 * "Try mission" playground: build a chain, flip a simulated Pro entitlement, run it
 * standalone and inspect the events the runner emitted. Nothing here dismisses an alarm.
 */
export function MissionScreen() {
  const [steps, setSteps] = useState<MissionStep[]>([{ missionId: 'math', config: {} }]);
  const [pro, setPro] = useState(true);
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [events, setEvents] = useState<MissionChainEvent[]>([]);

  if (run.status === 'running') {
    return (
      <View className="flex-1 bg-background px-4 pb-8 pt-4">
        <MissionChainRunner
          key={run.id}
          steps={steps}
          entitlement={{ pro }}
          onEvent={(event) => setEvents((current) => [...current, event])}
          onAllComplete={(attempts) =>
            setRun({ status: 'finished', outcome: 'completed', attempts })
          }
          onAbandon={(attempts) => setRun({ status: 'finished', outcome: 'left', attempts })}
        />
      </View>
    );
  }

  return (
    <Screen>
      {run.status === 'finished' ? (
        <Section
          title={run.outcome === 'completed' ? 'Mission complete' : 'You left the mission'}
          footer={
            run.outcome === 'left'
              ? 'Leaving is not a dismissal: a ringing alarm would keep ringing.'
              : undefined
          }
        >
          <ScrollView scrollEnabled={false}>
            {events.map((event, i) => (
              <View key={i}>
                {i > 0 ? <Separator /> : null}
                <Text selectable className="px-4 py-2 text-footnote text-foreground">
                  {describeEvent(event)}
                </Text>
              </View>
            ))}
          </ScrollView>
        </Section>
      ) : null}

      <MissionChainEditor
        steps={steps}
        onChange={setSteps}
        entitlement={{ pro }}
        onRequestUpgrade={() => router.push('/paywall')}
      />

      <Section footer="Testing only. Turn off to see Pro missions degrade to Math, as they do when the entitlement is missing at ring time.">
        <View className="min-h-touch flex-row items-center justify-between px-4 py-2">
          <Text className="text-body text-foreground">Simulate Pro</Text>
          <NativeSwitch value={pro} onValueChange={setPro} label="Simulate Pro" />
        </View>
      </Section>

      <Button
        title="Start mission"
        size="lg"
        onPress={() => {
          setEvents([]);
          setRun({ status: 'running', id: Date.now() });
        }}
      />
      <Button title="Close" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
