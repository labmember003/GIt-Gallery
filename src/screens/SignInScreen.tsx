import React, { useState } from 'react';
import { View, Linking, Image } from 'react-native';
import { Button, Text, useTheme, Card } from 'react-native-paper';
import * as Clipboard from 'expo-clipboard';
import { useAppStore } from '@/store/appState';
import { startDeviceFlow, pollForToken } from '@/services/auth';

export default function SignInScreen({ navigation }: any) {
  const theme = useTheme();
  const setAuthToken = useAppStore((s) => s.setAuthToken);
  const [loading, setLoading] = useState(false);

  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    const abort = new AbortController();
    try {
      setError(null);
      const flow = await startDeviceFlow();
      setDeviceCode(flow.device_code);
      setUserCode(flow.user_code);
      setVerifyUrl(flow.verification_uri_complete ?? flow.verification_uri);
      const token = await pollForToken(flow.device_code, flow.interval, abort.signal);
      setAuthToken(token);
      navigation.replace('RepoSetup');
    } catch (e: any) {
      setError(
        'Could not start GitHub Device Flow. Ensure it is enabled in your GitHub OAuth App settings and try again.',
      );
      console.warn('DeviceFlow error', e);
    } finally {
      abort.abort();
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Card mode="elevated" style={{ width: '100%', maxWidth: 440, borderRadius: 20, padding: 20, backgroundColor: theme.colors.surfaceVariant }}>
        <View style={{ alignItems: 'center', marginBottom: 16 }}>
          <Image source={require('../../assets/icon.png')} style={{ width: 72, height: 72, borderRadius: 16 }} />
          <Text variant="titleLarge" style={{ marginTop: 8 }}>GitGallery</Text>
        </View>
        <Text style={{ textAlign: 'center', marginBottom: 16 }}>
          Sign in with GitHub to allow private repo access.
        </Text>
        <Button mode="contained" onPress={signIn} loading={loading}>
          Continue with GitHub
        </Button>
        {error ? (
          <Text style={{ color: 'crimson', marginTop: 12, textAlign: 'center' }}>{error}</Text>
        ) : null}
        {userCode ? (
          <View style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={{ marginBottom: 8 }}>Enter this code on GitHub:</Text>
            <Text variant="titleLarge" style={{ letterSpacing: 2 }}>{userCode}</Text>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              {verifyUrl ? (
                <Button mode="outlined" onPress={() => Linking.openURL(verifyUrl!)}>
                  Open activation page
                </Button>
              ) : null}
              <Button mode="text" onPress={() => Clipboard.setStringAsync(userCode)}>
                Copy code
              </Button>
            </View>
          </View>
        ) : null}
      </Card>
    </View>
  );
}


