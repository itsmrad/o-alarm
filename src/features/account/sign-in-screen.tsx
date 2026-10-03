import { isClerkAPIResponseError, useSignIn, useSignUp, useSSO } from '@clerk/expo';
import { useSignInWithApple } from '@clerk/expo/apple';
import * as AuthSession from 'expo-auth-session';
import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { Screen } from '@/components/screen';
import { useAccount } from '@/lib/auth';
import { useThemeColors } from '@/theme/tokens';

// Completes a pending OAuth redirect when the browser hands control back to the app.
WebBrowser.maybeCompleteAuthSession();

const errorMessage = (error: unknown): string => {
  if (isClerkAPIResponseError(error)) {
    return error.errors[0]?.longMessage ?? error.errors[0]?.message ?? error.message;
  }
  const clerk = error as { longMessage?: string; message?: string } | null;
  return clerk?.longMessage || clerk?.message || 'Something went wrong. Please try again.';
};

const isNotFound = (error: unknown): boolean => {
  if (isClerkAPIResponseError(error)) {
    return error.errors.some((e) => e.code === 'form_identifier_not_found');
  }
  return (error as { code?: string } | null)?.code === 'form_identifier_not_found';
};

const isCancelled = (error: unknown): boolean =>
  /cancel/i.test((error as { code?: string; message?: string } | null)?.code ?? '') ||
  /cancel/i.test((error as { message?: string } | null)?.message ?? '');

export function SignInScreen() {
  const account = useAccount();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Sign in', presentation: 'modal' }} />
      {account.configured ? (
        <ClerkSignIn />
      ) : (
        <Text className="text-body text-foreground-muted">
          Sign-in is not configured in this build. Your alarms work fully without an account.
        </Text>
      )}
    </Screen>
  );
}

/** Rendered only inside ClerkProvider (configured builds). */
function ClerkSignIn() {
  const account = useAccount();
  const colors = useThemeColors();
  const { startSSOFlow } = useSSO();
  const { startAppleAuthenticationFlow } = useSignInWithApple();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'start' | 'code'>('start');
  const [flow, setFlow] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (account.signedIn) router.back();
  }, [account.signedIn]);

  // Android: pre-warm the browser so OAuth opens quickly.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => void WebBrowser.coolDownAsync();
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (!isCancelled(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const withApple = () =>
    run(async () => {
      const { createdSessionId, setActive } = await startAppleAuthenticationFlow();
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
    });

  const withGoogle = () =>
    run(async () => {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri(),
      });
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
    });

  const sendCode = () =>
    run(async () => {
      const emailAddress = email.trim();
      const sent = await signIn.emailCode.sendCode({ emailAddress });
      if (!sent.error) {
        setFlow('signIn');
        setStep('code');
        return;
      }
      if (!isNotFound(sent.error)) throw sent.error;
      // New email: create the account with the same one-time code flow.
      const created = await signUp.create({ emailAddress });
      if (created.error) throw created.error;
      const signUpSent = await signUp.verifications.sendEmailCode();
      if (signUpSent.error) throw signUpSent.error;
      setFlow('signUp');
      setStep('code');
    });

  const verifyCode = () =>
    run(async () => {
      if (flow === 'signIn') {
        const verified = await signIn.emailCode.verifyCode({ code: code.trim() });
        if (verified.error) throw verified.error;
        if (signIn.status !== 'complete') throw new Error('Additional verification is required.');
        const done = await signIn.finalize();
        if (done.error) throw done.error;
      } else {
        const verified = await signUp.verifications.verifyEmailCode({ code: code.trim() });
        if (verified.error) throw verified.error;
        if (signUp.status !== 'complete') throw new Error('Additional details are required.');
        const done = await signUp.finalize();
        if (done.error) throw done.error;
      }
    });

  const input = 'min-h-touch rounded-control bg-surface px-4 text-body text-foreground';
  return (
    <View className="gap-6">
      <Text className="text-body text-foreground-muted">
        An account backs up your alarm history and, with Pro, syncs it across devices. Your alarms
        work the same without one.
      </Text>

      {step === 'start' ? (
        <View className="gap-3">
          {Platform.OS === 'ios' ? (
            <Button title="Continue with Apple" onPress={() => void withApple()} disabled={busy} />
          ) : null}
          <Button
            title="Continue with Google"
            variant={Platform.OS === 'ios' ? 'secondary' : 'primary'}
            onPress={() => void withGoogle()}
            disabled={busy}
          />
          <Text className="pt-2 text-footnote uppercase text-foreground-muted">Or use email</Text>
          <TextInput
            accessibilityLabel="Email address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors['foreground-muted']}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            className={input}
          />
          <Button
            title="Email me a code"
            variant="secondary"
            onPress={() => void sendCode()}
            disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())}
          />
        </View>
      ) : (
        <View className="gap-3">
          <Text className="text-body text-foreground">Enter the code sent to {email.trim()}.</Text>
          <TextInput
            accessibilityLabel="Verification code"
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            placeholderTextColor={colors['foreground-muted']}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={8}
            className={input}
          />
          <Button
            title="Verify"
            onPress={() => void verifyCode()}
            disabled={busy || code.trim().length < 4}
          />
          <Button
            title="Use a different email"
            variant="secondary"
            onPress={() => {
              setStep('start');
              setCode('');
              setError(null);
            }}
            disabled={busy}
          />
        </View>
      )}

      {error ? <Text className="text-callout text-danger">{error}</Text> : null}
    </View>
  );
}
