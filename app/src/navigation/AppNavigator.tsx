import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CustomTabBar from '@/navigation/CustomTabBar';
import WelcomeScreen from '@/screens/WelcomeScreen';
import SignInScreen from '@/screens/SignInScreen';
import RepoSetupScreen from '@/screens/RepoSetupScreen';
import GalleryScreen from '@/screens/GalleryScreen';
import SettingsScreen from '@/screens/SettingsScreen';
import AlbumsScreen from '@/screens/AlbumsScreen';
import { useAppStore } from '@/store/appState';

type RootStackParamList = {
  Onboarding: undefined;
  Main: undefined;
  RepoSetup: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function MainTabs() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const headerOptions = useImmichHeaderOptions();
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        ...headerOptions,
        headerShown: true,
        tabBarShowLabel: true,
      }}
    >
      <Tab.Screen
        name="GitGallery"
        component={GalleryScreen}
        options={{
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="image-multiple" size={22} color={color} />
          ),
          tabBarLabel: 'Gallery',
          title: 'GitGallery',
          headerTitle: 'GitGallery',
        }}
      />
      <Tab.Screen
        name="Albums"
        component={AlbumsScreen}
        options={{
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="image-album" size={22} color={color} />
          ),
          tabBarLabel: 'Albums',
          title: 'Albums',
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="cog" size={22} color={color} />
          ),
          tabBarLabel: 'Settings',
          title: 'Settings',
        }}
      />
    </Tab.Navigator>
  );
}

/**
 * Immich's AppBar: surface background, primary-colored title, centered, no
 * elevation (reference/immich/mobile/lib/theme/theme_data.dart:38-48).
 */
function useImmichHeaderOptions() {
  const theme = useTheme();
  return {
    headerTitleAlign: 'center' as const,
    headerShadowVisible: false,
    headerStyle: { backgroundColor: theme.colors.surface },
    headerTintColor: theme.colors.primary,
    headerTitleStyle: { color: theme.colors.primary, fontWeight: '600' as const, fontSize: 18 },
  };
}

function OnboardingStack() {
  const Onboarding = createNativeStackNavigator();
  const headerOptions = useImmichHeaderOptions();
  return (
    <Onboarding.Navigator screenOptions={headerOptions}>
      <Onboarding.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
      <Onboarding.Screen name="SignIn" component={SignInScreen} options={{ title: 'Sign in with GitHub' }} />
      <Onboarding.Screen name="RepoSetup" component={RepoSetupScreen} options={{ title: 'Repository Setup' }} />
    </Onboarding.Navigator>
  );
}

/** Shown while persisted auth is read back, so onboarding never flashes. */
function SplashScreen() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

export default function AppNavigator() {
  const hydrated = useAppStore((s) => s.hydrated);
  const hasAuth = useAppStore((s) => !!s.authToken);
  const hasRepo = useAppStore((s) => !!s.currentRepo);

  const isReady = hasAuth && hasRepo;

  // Rendering before hydration would show onboarding to a signed-in user for a
  // frame or two, then swap — a visible flash on every cold start.
  if (!hydrated) return <SplashScreen />;

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isReady ? (
        <Stack.Screen name="Main" component={MainTabs} />
      ) : (
        <Stack.Screen name="Onboarding" component={OnboardingStack} />
      )}
      <Stack.Screen
        name="RepoSetup"
        component={RepoSetupScreen}
        options={{ headerShown: true, title: 'Repository Setup' }}
      />
    </Stack.Navigator>
  );
}


