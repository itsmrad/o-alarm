import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { useEntitlement } from '@/lib/entitlements';
import {
  FALLBACK_OFFERING,
  useOptionalPurchases,
  useProStatus,
  type PlanOffering,
  type PlanPackage,
} from '@/lib/purchases';
import { useThemeColors } from '@/theme/tokens';

import { PRO_FEATURES, RELIABILITY_LINE, ROLLOUT_NOTE, reasonCopy } from './copy';
import { privacyUrl, storeSubscriptionsUrl, termsUrl } from './links';

type OfferingState =
  | { status: 'loading' }
  | { status: 'ready'; offering: PlanOffering }
  /** Store prices could not be loaded: show labels, but nothing can be bought. */
  | { status: 'unavailable'; offering: PlanOffering };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const open = (url: string) => WebBrowser.openBrowserAsync(url).catch(() => undefined);

/** Whole-percent saving of the annual plan versus twelve months, or null if unknown. */
export function annualSavings(monthly: PlanPackage | null, annual: PlanPackage | null) {
  if (!monthly?.price || !annual?.price) return null;
  const percent = Math.round((1 - annual.price / (monthly.price * 12)) * 100);
  return percent > 0 ? percent : null;
}

function PlanCard({
  plan,
  selected,
  badge,
  onSelect,
}: {
  plan: PlanPackage;
  selected: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const colors = useThemeColors();
  const yearly = plan.period === 'year';
  const label = yearly ? 'Yearly' : 'Monthly';
  const price = `${plan.priceString} / ${yearly ? 'year' : 'month'}`;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}, ${price}${badge ? `, ${badge}` : ''}`}
      onPress={onSelect}
      className={`min-h-touch-lg flex-row items-center gap-3 rounded-card border-2 bg-surface px-4 py-3 ${
        selected ? 'border-accent' : 'border-border'
      }`}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={colors[selected ? 'accent' : 'foreground-muted']}
      />
      <View className="flex-1 gap-0.5">
        <Text className="text-headline text-foreground">{label}</Text>
        {yearly && plan.perMonthString ? (
          <Text className="text-footnote text-foreground-muted">
            About {plan.perMonthString} / month
          </Text>
        ) : null}
      </View>
      <View className="items-end gap-0.5">
        <Text className="text-headline text-foreground">{price}</Text>
        {badge ? <Text className="text-caption font-semibold text-accent">{badge}</Text> : null}
      </View>
    </Pressable>
  );
}

export function PaywallScreen() {
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const colors = useThemeColors();
  const purchases = useOptionalPurchases();
  const status = useProStatus();
  const { tier } = useEntitlement();
  const isPro = tier === 'pro';

  const [state, setState] = useState<OfferingState>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const offering = purchases ? await purchases.getOffering() : null;
        if (offering && (offering.monthly || offering.annual)) {
          if (cancelled) return;
          setState({ status: 'ready', offering });
          setSelectedId((offering.annual ?? offering.monthly)?.id ?? null);
          return;
        }
      } catch {
        // Fall through to the labelled fallback.
      }
      if (!cancelled) setState({ status: 'unavailable', offering: FALLBACK_OFFERING });
    })();
    return () => {
      cancelled = true;
    };
  }, [purchases, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  const offering = state.status === 'loading' ? null : state.offering;
  const monthly = offering?.monthly ?? null;
  const annual = offering?.annual ?? null;
  const selected = [monthly, annual].find((plan) => plan?.id === selectedId) ?? null;
  const mode = purchases?.client.mode;
  const mock = mode?.kind === 'mock';
  const canBuy = state.status === 'ready' && !!selected && !!purchases && !isPro;
  const savings = annualSavings(monthly, annual);

  const purchase = async () => {
    if (!purchases || !selected) return;
    setBusy('buy');
    try {
      const outcome = await purchases.purchase(selected.id);
      if (outcome === 'purchased') close();
      else if (outcome === 'pending') {
        Alert.alert(
          'Purchase pending',
          'Pro will unlock as soon as the store confirms your purchase.',
        );
      }
    } catch (error) {
      Alert.alert('Purchase failed', `${message(error)}\n\nYou have not been charged.`);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!purchases) return;
    setBusy('restore');
    try {
      const active = await purchases.restore();
      Alert.alert(
        active ? 'Pro restored' : 'Nothing to restore',
        active
          ? 'Your subscription is active on this device.'
          : 'We could not find an active Pro subscription for this store account.',
      );
    } catch (error) {
      Alert.alert(
        'Could not restore purchases',
        `${message(error)}\n\nCheck your connection and try again.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (router.canGoBack()) router.back();
  };

  const manage = () => open(status?.managementUrl || storeSubscriptionsUrl());
  const privacy = privacyUrl();
  const notice = reasonCopy(reason);

  return (
    <Screen>
      <View className="items-center gap-2 pt-2">
        <Ionicons name="sparkles" size={36} color={colors.accent} />
        <Text accessibilityRole="header" className="text-title1 text-foreground">
          {isPro ? "You're on O-Alarm Pro" : 'O-Alarm Pro'}
        </Text>
        <Text className="text-center text-body text-foreground-muted">
          {isPro
            ? 'Thank you for supporting O-Alarm.'
            : (notice ?? 'Go further than a great alarm.')}
        </Text>
      </View>

      <View className="gap-1 rounded-card bg-surface-muted p-4">
        <Text className="text-callout text-foreground">{RELIABILITY_LINE}</Text>
      </View>

      <Section title="Pro includes" footer={ROLLOUT_NOTE}>
        {PRO_FEATURES.map((feature, index) => (
          <View key={feature}>
            {index > 0 ? <Separator /> : null}
            <View className="min-h-touch flex-row items-center gap-3 px-4 py-3">
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text className="flex-1 text-body text-foreground">{feature}</Text>
            </View>
          </View>
        ))}
      </Section>

      {isPro ? (
        <Section
          footer={
            status?.billingIssue
              ? 'The store could not charge your payment method. Update it to keep Pro.'
              : status?.expiresAt
                ? `${status.willRenew ? 'Renews' : 'Ends'} ${new Date(status.expiresAt).toLocaleDateString()}.`
                : undefined
          }
        >
          <ListRow title="Manage subscription" onPress={() => void manage()} />
        </Section>
      ) : (
        <View className="gap-3">
          {state.status === 'loading' ? (
            <Text className="text-center text-body text-foreground-muted">Loading prices…</Text>
          ) : (
            <View accessibilityRole="radiogroup" className="gap-3">
              {annual ? (
                <PlanCard
                  plan={annual}
                  selected={selectedId === annual.id}
                  badge={savings ? `Save ${savings}%` : 'Best value'}
                  onSelect={() => setSelectedId(annual.id)}
                />
              ) : null}
              {monthly ? (
                <PlanCard
                  plan={monthly}
                  selected={selectedId === monthly.id}
                  onSelect={() => setSelectedId(monthly.id)}
                />
              ) : null}
            </View>
          )}

          {state.status === 'unavailable' ? (
            <View className="gap-2">
              <Text className="text-center text-footnote text-foreground-muted">
                {"Couldn't load current prices from the store. Check your connection."}
              </Text>
              <Button title="Try again" variant="secondary" onPress={retry} />
            </View>
          ) : null}

          {mock && !mode.simulate && state.status !== 'loading' ? (
            <Text className="text-center text-footnote text-foreground-muted">
              Purchases are not available in this build. Prices shown are targets.
            </Text>
          ) : null}

          {mode?.kind === 'mock' && mode.simulate && state.status !== 'loading' ? (
            <Text className="text-center text-footnote text-warning-foreground">
              Preview mode: buying simulates Pro on this device only.
            </Text>
          ) : null}

          <Button
            size="lg"
            title={
              busy === 'buy'
                ? 'Processing…'
                : selected
                  ? `Continue · ${selected.priceString} / ${selected.period}`
                  : 'Continue'
            }
            disabled={!canBuy || busy !== null || (mock && !mode.simulate)}
            onPress={() => void purchase()}
          />
          <Text className="text-center text-footnote text-foreground-muted">
            Payment is charged to your store account. The subscription renews automatically until
            you cancel at least 24 hours before the period ends. Manage or cancel any time in your
            store account settings.
          </Text>
        </View>
      )}

      <Section>
        <ListRow
          title={busy === 'restore' ? 'Restoring…' : 'Restore purchases'}
          disabled={!purchases || busy !== null}
          onPress={() => void restore()}
        />
        {!isPro ? (
          <>
            <Separator />
            <ListRow title="Manage subscription" onPress={() => void manage()} />
          </>
        ) : null}
        <Separator />
        <ListRow title="Terms of Use" onPress={() => void open(termsUrl())} />
        {privacy ? (
          <>
            <Separator />
            <ListRow title="Privacy Policy" onPress={() => void open(privacy)} />
          </>
        ) : null}
      </Section>

      <Button
        title={isPro ? 'Done' : 'Not now'}
        variant="secondary"
        onPress={close}
      />
    </Screen>
  );
}
