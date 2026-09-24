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

/**
 * Dev-only auth bypass.
 *
 * Device Flow needs a registered OAuth App and a human entering a code in a
 * browser, which makes every reinstall a manual step. For local development we
 * accept a fine-grained PAT from `.env` instead.
 *
 * This must stay a *development* path:
 *  - `__DEV__` gates it out of release builds entirely.
 *  - The token belongs in `.env` (gitignored), never in source or app.json.
 *  - Scope it to one repository with Contents: Read and write. This app calls
 *    `deleteFile` and `git.updateRef`, so a broadly-scoped token would let a bug
 *    reach every repo it can see.
 *
 * Shipping still requires real Device Flow — this does not replace it.
 */
export const getDevToken = (): string | null => {
  if (!__DEV__) return null;
  const token = process.env.EXPO_PUBLIC_GITHUB_TOKEN;
  return token && token.length > 0 ? token : null;
};

/** Optional `owner/name` to preselect in dev, skipping the repo picker. */
export const getDevRepo = (): { owner: string; name: string } | null => {
  if (!__DEV__) return null;
  const raw = process.env.EXPO_PUBLIC_GITHUB_TEST_REPO;
  if (!raw) return null;
  const [owner, name] = raw.split('/');
  return owner && name ? { owner, name } : null;
};


