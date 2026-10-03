import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import type { StructuredInsight, WakeAnalysis } from '@/domain/insights';
import type { ExplainTopic } from '@/domain/insights-payload';
import { usePaywall } from '@/features/paywall/use-paywall';
import { describeRationale, formatTime } from '@/features/sleep/format';
import type { AiAvailability, AiExplanation, AiUnavailableReason } from '@/lib/ai';
import { useThemeColors } from '@/theme/tokens';

import {
  chainName,
  describeInsight,
  evidenceNote,
  formatWeekRange,
  pct,
  weekFigures,
} from './copy';
import { useExplanation, useWeeklyReport, type AiState } from './use-ai';
import { useInsightsData, type InsightsData } from './use-insights';

/**
 * Insights tab: deterministic, on-device analysis for everyone (free, offline), plus Pro AI
 * explanations of the same numbers. The AI only explains and suggests; any change to an alarm
 * happens in the alarm editor, saved by the user (PRODUCT.md: AI never changes alarms).
 */
export function InsightsScreen() {
  const data = useInsightsData();
  const { analysis } = data;
  const patterns = analysis.insights.filter(
    (i) => i.kind !== 'mission_effectiveness' && i.kind !== 'sleep_energy',
  );

  return (
    <Screen>
      <ThisWeek analysis={analysis} />
      <WeeklyReport data={data} />

      <Section
        title="Patterns"
        footer={`From your last ${analysis.pattern.mornings} alarm mornings (6 weeks).`}
      >
        {patterns.length === 0 ? (
          <Empty text="Patterns appear after about 5 alarm mornings. Keep using your alarm as usual." />
        ) : (
          patterns.map((insight, index) => (
            <View key={insight.id}>
              {index > 0 ? <Separator /> : null}
              <InsightRow insight={insight} />
            </View>
          ))
        )}
      </Section>
      {patterns.length > 0 ? <Explain topic="wake_pattern" data={data} /> : null}

      <MissionRecommendation data={data} />
      <BedtimeExplanation data={data} />
      <SleepVsEnergy analysis={analysis} />

      <Text className="px-4 text-footnote text-foreground-muted">
        Insights are computed on this device. AI explanations (Pro) receive only these summary
        numbers, never your alarm history, labels or times, and can never change your alarms.
      </Text>
    </Screen>
  );
}

// ------------------------------------------------------------------------------- sections

function ThisWeek({ analysis }: { analysis: WakeAnalysis }) {
  const week = analysis.thisWeek;
  const figures = weekFigures(week);
  return (
    <View className="gap-3 rounded-card bg-surface p-5" accessibilityRole="summary">
      <Text className="text-footnote font-semibold uppercase text-foreground-muted">
        This week · {formatWeekRange(week.start, week.end)}
      </Text>
      {week.enoughData ? (
        <Text className="text-title2 text-foreground">
          {week.mornings} alarm mornings
          {week.missed ? `, ${week.missed} missed` : ''}
        </Text>
      ) : (
        <Text className="text-body text-foreground-muted">
          {week.mornings === 0
            ? 'No alarm mornings yet this week.'
            : `${week.mornings} alarm ${week.mornings === 1 ? 'morning' : 'mornings'} so far. The summary fills in after 3.`}
        </Text>
      )}
      {figures.length ? (
        <View className="flex-row flex-wrap gap-y-3">
          {figures.map((f) => (
            <View key={f.label} className="w-1/2 gap-0.5">
              <Text className="text-title3 text-foreground">{f.value}</Text>
              <Text className="text-footnote text-foreground-muted">{f.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function WeeklyReport({ data }: { data: InsightsData }) {
  const { analysis, bedtimeAi } = data;
  const report = useWeeklyReport(analysis, bedtimeAi);
  const { openPaywall } = usePaywall();
  const week = analysis.lastWeek;

  let body: ReactNode;
  if (!report.enoughData) {
    body = (
      <Text className="text-body text-foreground-muted">
        Your weekly report arrives after a week with at least 3 alarm mornings.
      </Text>
    );
  } else if (report.state.status === 'ok') {
    body = <ExplanationView explanation={report.state.explanation} data={data} />;
  } else {
    const figures = weekFigures(week);
    body = (
      <>
        <Text className="text-body text-foreground">
          {week.mornings} alarm mornings
          {week.successRate !== null ? `, up on time ${pct(week.successRate)} of them` : ''}.
        </Text>
        {figures.length ? (
          <Text className="text-callout text-foreground-muted">
            {figures.map((f) => `${f.label}: ${f.value}`).join(' · ')}
          </Text>
        ) : null}
        <AiStatus
          availability={report.availability}
          state={report.state}
          onRetry={report.retry}
          onUpgrade={() => openPaywall('insights')}
          upgradeTitle="Get the AI weekly report"
          loadingText="Writing your weekly report…"
        />
      </>
    );
  }

  return (
    <View className="gap-3 rounded-card bg-surface p-5">
      <Text className="text-footnote font-semibold uppercase text-foreground-muted">
        Weekly wake report · {formatWeekRange(week.start, week.end)}
      </Text>
      {body}
    </View>
  );
}

function MissionRecommendation({ data }: { data: InsightsData }) {
  const { analysis } = data;
  const rec = analysis.missionRecommendation;
  const insight = analysis.insights.find((i) => i.kind === 'mission_effectiveness');
  return (
    <>
      <Section
        title="Missions"
        footer={
          rec.status === 'insufficient_data'
            ? 'A recommendation needs at least 4 mornings with each of two different missions.'
            : 'Success = the alarm was dismissed and did not need to ring again.'
        }
      >
        {insight ? <InsightRow insight={insight} /> : null}
        {analysis.chains.slice(0, 3).map((chain, index) => (
          <View key={chain.chain.join('>')}>
            {index > 0 || insight ? <Separator /> : null}
            <View className="min-h-touch flex-row items-center gap-3 px-4 py-3">
              <Text className="flex-1 text-body text-foreground">{chainName(chain.chain)}</Text>
              <Text className="text-body text-foreground-muted">
                {pct(chain.successRate)} · {chain.uses}×
              </Text>
            </View>
          </View>
        ))}
        {!insight && analysis.chains.length === 0 ? (
          <Empty text="No mission mornings yet. Add a mission to an alarm to compare what works." />
        ) : null}
      </Section>
      {insight ? <Explain topic="mission_recommendation" data={data} /> : null}
    </>
  );
}

function BedtimeExplanation({ data }: { data: InsightsData }) {
  const { bedtime, timeZone, prefs } = data;
  if (bedtime.status !== 'ok' || !bedtime.bedtime) {
    return (
      <Section title="Bedtime">
        <Empty text="No alarm to plan a bedtime around. Set an alarm or a manual bedtime in Bedtime." />
      </Section>
    );
  }
  return (
    <>
      <Section title="Bedtime">
        <View className="gap-2 px-4 py-3">
          <Text className="text-title3 text-foreground">
            Tonight: {formatTime(bedtime.bedtime, timeZone)}
          </Text>
          {bedtime.rationale.map((code) => (
            <Text key={code} className="text-callout text-foreground-muted">
              {describeRationale(code, bedtime, prefs, timeZone)}
            </Text>
          ))}
        </View>
      </Section>
      <Explain topic="bedtime_recommendation" data={data} />
    </>
  );
}

function SleepVsEnergy({ analysis }: { analysis: WakeAnalysis }) {
  const se = analysis.sleepEnergy;
  const max = 5;
  return (
    <Section
      title="Sleep and morning energy"
      footer="An association in your own check-ins, not a cause. Many things affect how you feel in the morning."
    >
      {se.buckets.every((b) => b.checkIns === 0) ? (
        <Empty text="Answer the morning check-in after a few nights to compare sleep and energy." />
      ) : (
        <View className="gap-3 px-4 py-3">
          {se.buckets.map((bucket) => (
            <View
              key={bucket.label}
              className="flex-row items-center gap-3"
              accessible
              accessibilityLabel={
                bucket.avgEnergy === null
                  ? `${bucket.label} of sleep: no check-ins`
                  : `${bucket.label} of sleep: average energy ${bucket.avgEnergy} of 5 from ${bucket.checkIns} check-ins`
              }
            >
              <Text className="w-12 text-footnote text-foreground-muted">{bucket.label}</Text>
              <View className="h-3 flex-1 overflow-hidden rounded-full bg-surface-muted">
                {bucket.avgEnergy !== null ? (
                  <View
                    className="h-3 rounded-full bg-accent"
                    style={{ width: `${(bucket.avgEnergy / max) * 100}%` }}
                  />
                ) : null}
              </View>
              <Text className="w-16 text-right text-footnote text-foreground-muted">
                {bucket.avgEnergy === null ? '–' : `${bucket.avgEnergy}/5`} ({bucket.checkIns})
              </Text>
            </View>
          ))}
          <Text className="text-footnote text-foreground-muted">
            {se.enoughData
              ? `Shorter nights = under ${Math.round(se.shortNightThresholdMin / 60)} h for your goal.`
              : 'A comparison needs at least 3 check-ins after shorter nights and 3 after longer ones.'}
          </Text>
        </View>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------- pieces

function InsightRow({ insight }: { insight: StructuredInsight }) {
  const { title, body } = describeInsight(insight);
  const dot =
    insight.tone === 'positive'
      ? 'bg-success'
      : insight.tone === 'attention'
        ? 'bg-warning'
        : 'bg-foreground-muted';
  return (
    <View className="flex-row gap-3 px-4 py-3" accessible>
      <View className={`mt-2 h-2 w-2 rounded-full ${dot}`} />
      <View className="flex-1 gap-1">
        <Text className="text-body text-foreground">{title}</Text>
        <Text className="text-callout text-foreground-muted">{body}</Text>
        <Text className="text-caption text-foreground-muted">{evidenceNote(insight)}</Text>
      </View>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Text className="px-4 py-3 text-callout text-foreground-muted">{text}</Text>;
}

function Explain({ topic, data }: { topic: ExplainTopic; data: InsightsData }) {
  const { availability, state, explain } = useExplanation(topic, data.analysis, data.bedtimeAi);
  const { openPaywall } = usePaywall();
  if (state.status === 'ok') {
    return (
      <View className="gap-3 rounded-card bg-surface p-5">
        <ExplanationView explanation={state.explanation} data={data} />
      </View>
    );
  }
  return (
    <View className="px-4">
      <AiStatus
        availability={availability}
        state={state}
        onRetry={explain}
        onUpgrade={() => openPaywall('insights')}
        upgradeTitle="Explain with Pro"
        idleTitle="Explain this"
        loadingText="Explaining…"
      />
    </View>
  );
}

const REASON_COPY: Record<AiUnavailableReason, string> = {
  not_configured: 'AI explanations are not available in this build.',
  signed_out: 'Sign in to get AI explanations.',
  pro_required: 'AI explanations are part of Pro.',
  rate_limited: 'You have used this week’s AI explanations. They renew within 7 days.',
  offline: 'You appear to be offline. Your insights above are still up to date.',
  service_unavailable:
    'The AI explanation is unavailable right now. Your insights above are complete.',
  invalid_output: 'The AI explanation did not meet our quality checks, so it is not shown.',
  error: 'Something went wrong getting the AI explanation.',
};

function AiStatus({
  availability,
  state,
  onRetry,
  onUpgrade,
  upgradeTitle,
  idleTitle,
  loadingText,
}: {
  availability: AiAvailability;
  state: AiState;
  onRetry: () => void;
  onUpgrade: () => void;
  upgradeTitle: string;
  /** Shown for an on-demand request that has not run yet. */
  idleTitle?: string;
  loadingText: string;
}) {
  const colors = useThemeColors();
  if (availability === 'free') {
    return <Button title={upgradeTitle} variant="secondary" onPress={onUpgrade} />;
  }
  if (availability === 'not_configured') {
    return (
      <Text className="text-footnote text-foreground-muted">{REASON_COPY.not_configured}</Text>
    );
  }
  if (availability === 'signed_out') {
    return (
      <Button
        title="Sign in for AI explanations"
        variant="secondary"
        onPress={() => router.push('/sign-in')}
      />
    );
  }
  if (state.status === 'loading') {
    return (
      <View className="min-h-touch flex-row items-center gap-3" accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors['foreground-muted']} />
        <Text className="text-callout text-foreground-muted">{loadingText}</Text>
      </View>
    );
  }
  if (state.status === 'unavailable') {
    const canRetry = state.reason !== 'rate_limited' && state.reason !== 'not_configured';
    return (
      <View className="gap-2">
        <Text className="text-footnote text-foreground-muted">{REASON_COPY[state.reason]}</Text>
        {canRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
      </View>
    );
  }
  return idleTitle ? <Button title={idleTitle} variant="secondary" onPress={onRetry} /> : null;
}

function ExplanationView({
  explanation,
  data,
}: {
  explanation: AiExplanation;
  data: InsightsData;
}) {
  return (
    <View className="gap-3">
      <Text className="text-title3 text-foreground">{explanation.headline}</Text>
      <Text className="text-body text-foreground">{explanation.summary}</Text>
      {explanation.suggestions.map((s) => {
        const action = suggestionAction(s.basedOn, data);
        return (
          <View key={s.text} className="gap-2 rounded-control bg-surface-muted p-3">
            <Text className="text-callout text-foreground">{s.text}</Text>
            {action ? (
              <Button
                title={action.title}
                variant="secondary"
                accessibilityHint={action.hint}
                onPress={action.onPress}
              />
            ) : null}
          </View>
        );
      })}
      <Text className="text-caption text-foreground-muted">
        AI explanation of the numbers above. A suggestion is only an idea: nothing changes unless
        you edit and save it yourself.
      </Text>
    </View>
  );
}

const ALARM_KINDS = new Set<StructuredInsight['kind']>([
  'wake_success',
  'snoozing',
  'dismissal_time',
  'wake_check',
  'returned_to_sleep',
  'difficult_weekday',
  'mission_effectiveness',
]);
const SLEEP_KINDS = new Set<StructuredInsight['kind']>(['consistency', 'sleep_energy']);

/**
 * Where a suggestion can take the user. Deterministic, from the insight it rests on; it only
 * opens a screen. The alarm editor opens on the user's main alarm, unchanged, to edit and save.
 */
export function suggestionAction(
  basedOn: string,
  data: Pick<InsightsData, 'analysis' | 'alarms'>,
): { title: string; hint: string; onPress: () => void } | null {
  const kind = data.analysis.insights.find((i) => i.id === basedOn)?.kind;
  if (basedOn === 'bedtime' || (kind && SLEEP_KINDS.has(kind))) {
    return {
      title: 'Open Bedtime',
      hint: 'Opens your bedtime settings',
      onPress: () => router.push('/bedtime'),
    };
  }
  const alarmId = data.analysis.primaryAlarmId;
  if (kind && ALARM_KINDS.has(kind) && alarmId && data.alarms.some((a) => a.id === alarmId)) {
    return {
      title: 'Review alarm',
      hint: 'Opens the alarm editor. Nothing changes until you save.',
      onPress: () => router.push({ pathname: '/alarm/[id]', params: { id: alarmId } }),
    };
  }
  return null;
}
