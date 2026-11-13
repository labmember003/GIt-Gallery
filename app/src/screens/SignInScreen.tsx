import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { ActivityIndicator, Button, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '@/store/appState';
import { DeviceFlowError, pollForToken, startDeviceFlow, type DeviceFlowErrorKind } from '@/services/auth';

type Phase =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'waiting'; userCode: string; verifyUrl: string; expiresAt: number }
  | { name: 'done' }
  | { name: 'error'; kind: DeviceFlowErrorKind };

const ERROR_TEXT: Record<DeviceFlowErrorKind, { title: string; body: string }> = {
  'start-failed': {
    title: "Couldn't reach GitHub",
    body: 'Check your internet connection and try again.',
  },
  expired: {
    title: 'That code expired',
    body: 'Codes last 15 minutes. Get a new one and approve it on GitHub.',
  },
  denied: {
    title: 'Sign-in was cancelled on GitHub',
    body: 'Nothing was shared. Try again whenever you are ready.',
  },
  disabled: {
    title: 'GitHub sign-in is unavailable',
    body: 'Device sign-in is turned off for this app on GitHub. Please contact support.',
  },
  misconfigured: {
    title: 'GitHub rejected the sign-in',
    body: 'Get a new code and try again. If it keeps happening, please contact support.',
  },
  cancelled: { title: 'Sign-in cancelled', body: 'Try again whenever you are ready.' },
};

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function SignInScreen({ navigation }: any) {
  const theme = useTheme();
  const colors = theme.colors as typeof theme.colors & { surfaceContainerHigh?: string };
  const setAuthToken = useAppStore((s) => s.setAuthToken);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  // Resolved whenever the app returns to the foreground, so the poll loop
  // checks GitHub immediately instead of waiting out its interval.
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') wakeRef.current();
    });
    return () => {
      sub.remove();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (phase.name !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase.name]);

  const signIn = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setCopied(false);
    setPhase({ name: 'starting' });
    try {
      const flow = await startDeviceFlow();
      if (abort.signal.aborted) return;
      setNow(Date.now());
      setPhase({
        name: 'waiting',
        userCode: flow.user_code,
        verifyUrl: flow.verification_uri_complete ?? flow.verification_uri,
        expiresAt: Date.now() + flow.expires_in * 1000,
      });
      const token = await pollForToken(flow.device_code, {
        intervalSec: flow.interval,
        expiresInSec: flow.expires_in,
        signal: abort.signal,
        wake: () => new Promise<void>((resolve) => { wakeRef.current = resolve; }),
      });
      if (abort.signal.aborted) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setPhase({ name: 'done' });
      setAuthToken(token);
      navigation.replace('RepoSetup');
    } catch (error: any) {
      if (abort.signal.aborted) return;
      const kind: DeviceFlowErrorKind = error instanceof DeviceFlowError ? error.kind : 'start-failed';
      console.warn('[sign-in] device flow ended', kind, error?.message);
      setPhase({ name: 'error', kind });
    }
  }, [navigation, setAuthToken]);

  const copyAndOpen = useCallback(async () => {
    if (phase.name !== 'waiting') return;
    await Clipboard.setStringAsync(phase.userCode).catch(() => {});
    setCopied(true);
    Haptics.selectionAsync().catch(() => {});
    Linking.openURL(phase.verifyUrl).catch(() => {});
  }, [phase]);

  const copyOnly = useCallback(async () => {
    if (phase.name !== 'waiting') return;
    await Clipboard.setStringAsync(phase.userCode).catch(() => {});
    setCopied(true);
    Haptics.selectionAsync().catch(() => {});
  }, [phase]);

  const cardColor = colors.surfaceContainerHigh ?? theme.colors.surfaceVariant;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface }}
      contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <View style={{ width: '100%', maxWidth: 440, borderRadius: 28, padding: 24, backgroundColor: cardColor }}>
        <View style={{ alignItems: 'center' }}>
          <Image source={require('../../assets/icon.png')} style={{ width: 64, height: 64, borderRadius: 16 }} />
          <Text variant="headlineSmall" style={{ marginTop: 12, fontWeight: '600', color: theme.colors.onSurface }}>
            Sign in with GitHub
          </Text>
          <Text variant="bodyMedium" style={{ marginTop: 8, textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
            Your photos are saved to a private repository in your own GitHub account. Only you can see them.
          </Text>
        </View>

        {phase.name === 'waiting' ? (
          <View style={{ marginTop: 24 }}>
            <Text variant="labelLarge" style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
              Your code
            </Text>
            <Pressable
              onPress={copyOnly}
              accessibilityRole="button"
              accessibilityLabel={`Code ${phase.userCode}. Tap to copy.`}
              style={{ marginTop: 8, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 16, backgroundColor: theme.colors.surface }}
            >
              <Text
                selectable
                style={{ fontSize: 30, lineHeight: 38, letterSpacing: 4, fontWeight: '700', fontVariant: ['tabular-nums'], color: theme.colors.primary }}
              >
                {phase.userCode}
              </Text>
            </Pressable>
            <Button
              mode="contained"
              icon={copied ? 'check' : 'open-in-new'}
              onPress={copyAndOpen}
              style={{ marginTop: 16, borderRadius: 999 }}
              contentStyle={{ height: 48 }}
            >
              {copied ? 'Copied, open GitHub again' : 'Copy code & open GitHub'}
            </Button>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
              <ActivityIndicator size={16} />
              <Text variant="bodyMedium" style={{ marginLeft: 10, color: theme.colors.onSurface }}>
                Waiting for you to approve on GitHub
              </Text>
            </View>
            <Text variant="bodySmall" style={{ textAlign: 'center', marginTop: 4, color: theme.colors.onSurfaceVariant }}>
              Code expires in {formatRemaining(phase.expiresAt - now)}
            </Text>

            <View style={{ marginTop: 20, padding: 14, borderRadius: 16, backgroundColor: theme.colors.surface }}>
              {[
                'Paste the code on GitHub and tap Continue.',
                'Tap the green Authorize button. It shows the developer’s GitHub name; that is normal.',
                'Come back here. You will be signed in automatically.',
              ].map((step, index) => (
                <View key={step} style={{ flexDirection: 'row', marginTop: index === 0 ? 0 : 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryContainer }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: theme.colors.onPrimaryContainer }}>{index + 1}</Text>
                  </View>
                  <Text variant="bodyMedium" style={{ flex: 1, marginLeft: 10, color: theme.colors.onSurfaceVariant }}>
                    {step}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : phase.name === 'error' ? (
          <View style={{ marginTop: 24 }}>
            <View style={{ flexDirection: 'row', padding: 14, borderRadius: 16, backgroundColor: theme.colors.errorContainer }}>
              <MaterialCommunityIcons name="alert-circle-outline" size={22} color={theme.colors.onErrorContainer} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text variant="titleSmall" style={{ color: theme.colors.onErrorContainer }}>{ERROR_TEXT[phase.kind].title}</Text>
                <Text variant="bodyMedium" style={{ marginTop: 2, color: theme.colors.onErrorContainer }}>{ERROR_TEXT[phase.kind].body}</Text>
              </View>
            </View>
            <Button mode="contained" onPress={signIn} style={{ marginTop: 16, borderRadius: 999 }} contentStyle={{ height: 48 }}>
              {phase.kind === 'expired' || phase.kind === 'misconfigured' ? 'Get a new code' : 'Try again'}
            </Button>
          </View>
        ) : (
          <Button
            mode="contained"
            icon="github"
            onPress={signIn}
            loading={phase.name === 'starting' || phase.name === 'done'}
            disabled={phase.name === 'starting' || phase.name === 'done'}
            style={{ marginTop: 24, borderRadius: 999 }}
            contentStyle={{ height: 48 }}
          >
            Continue with GitHub
          </Button>
        )}
      </View>
    </ScrollView>
  );
}
