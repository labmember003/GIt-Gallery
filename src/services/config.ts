export const getGithubClientId = (): string => {
  let clientId = process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID;
  if (!clientId) {
    try {
      const Constants = require('expo-constants').default;
      clientId = Constants.expoConfig?.extra?.EXPO_PUBLIC_GITHUB_CLIENT_ID || 
                 Constants.manifest?.extra?.EXPO_PUBLIC_GITHUB_CLIENT_ID;
    } catch {}
  }
  
  return clientId;
};

let _cachedClientId: string | null = null;

export const GITHUB_CLIENT_ID = (): string => {
  if (_cachedClientId === null) {
    _cachedClientId = getGithubClientId();
  }
  return _cachedClientId;
};

export const GITHUB_SCOPES = 'repo';


