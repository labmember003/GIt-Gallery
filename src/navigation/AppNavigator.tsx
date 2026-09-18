import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CustomTabBar from '@/navigation/CustomTabBar';
import WelcomeScreen from '@/screens/WelcomeScreen';
import SignInScreen from '@/screens/SignInScreen';
import RepoSetupScreen from '@/screens/RepoSetupScreen';
import GalleryScreen from '@/screens/GalleryScreen';
import SettingsScreen from '@/screens/SettingsScreen';
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
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: true,
        headerTitleAlign: 'center',
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

function OnboardingStack() {
  const Onboarding = createNativeStackNavigator();
  return (
    <Onboarding.Navigator>
      <Onboarding.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
      <Onboarding.Screen name="SignIn" component={SignInScreen} options={{ title: 'Sign in with GitHub' }} />
      <Onboarding.Screen name="RepoSetup" component={RepoSetupScreen} options={{ title: 'Repository Setup' }} />
    </Onboarding.Navigator>
  );
}

export default function AppNavigator() {
  const hasAuth = useAppStore((s) => !!s.authToken);
  const hasRepo = useAppStore((s) => !!s.currentRepo);

  const isReady = hasAuth && hasRepo;

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


