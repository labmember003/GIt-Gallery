import React from 'react';
import { View, Image, Linking } from 'react-native';
import { Button, Text, useTheme, Card, Divider, Chip } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PRIVACY_POLICY_URL } from '@/services/links';

type Props = NativeStackScreenProps<any>;

export default function WelcomeScreen({ navigation }: Props) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Card mode="elevated" style={{ width: '100%', maxWidth: 520, borderRadius: 24, overflow: 'hidden' }}>
        <View style={{ alignItems: 'center', paddingTop: 28, paddingHorizontal: 24 }}>
          <Image source={require('../../assets/icon.png')} style={{ width: 84, height: 84, borderRadius: 20 }} />
          <Text variant="displaySmall" style={{ marginTop: 8 }}>GitGallery</Text>
          <Text style={{ textAlign: 'center', marginTop: 8, opacity: 0.85 }}>
            Privacy-first gallery. Sync your media to your private GitHub repo.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Chip icon="lock" compact>Private</Chip>
            <Chip icon="github" compact>GitHub</Chip>
            <Chip icon="image-multiple" compact>Photos</Chip>
          </View>
        </View>
        <Divider style={{ marginTop: 20, opacity: 0.2 }} />
        <View style={{ padding: 24, alignItems: 'center' }}>
          <Button mode="contained" onPress={() => navigation.navigate('SignIn')}>
            Get Started
          </Button>
          <Button mode="text" icon="image-search-outline" style={{ marginTop: 8 }} onPress={() => navigation.navigate('Demo')}>
            Try the demo, no sign-in
          </Button>
        </View>
      </Card>
      <Button mode="text" compact style={{ marginTop: 12 }} labelStyle={{ fontSize: 13 }} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
        Privacy policy
      </Button>
    </View>
  );
}


