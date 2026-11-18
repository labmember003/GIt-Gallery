import { create } from 'zustand';
import { useAppStore } from '@/store/appState';
import { refreshGrant } from './auth';
import { createRenewer } from './authRenewal';

/**
 * Keeps the GitHub sign-in alive (see services/authRenewal).
 *
 * Every GitHub call asks `freshToken()` first, which renews the token a few
 * minutes before it runs out; a call that still gets a 401 renews once and
 * retries. Only when GitHub refuses the refresh token itself (unused for six
 * months, or access revoked) is the sign-in over.
 */

/**
 * Whether GitHub has ended the sign-in. Screens show a "Sign in again" banner
 * while this is set. `token` is the access token it was set for.
 */
export const useAuthHealth = create<{ ended: boolean; token: string | null }>(() => ({ ended: false, token: null }));

export function markSignInEnded(token: string | null): void {
  // A 401 from a token that has since been replaced says nothing about the new one.
  if (token && useAppStore.getState().authToken === token) useAuthHealth.setState({ ended: true, token });
}

// A new access token (sign-in or renewal) means GitHub is accepting us again.
useAppStore.subscribe((state, prev) => {
  if (state.authToken && state.authToken !== prev.authToken && useAuthHealth.getState().ended) {
    useAuthHealth.setState({ ended: false, token: state.authToken });
  }
});

export const { freshToken, withFreshToken } = createRenewer(
  {
    token: () => useAppStore.getState().authToken,
    refresh: () => useAppStore.getState().authRefresh,
    save: (grant) => useAppStore.getState().setAuthGrant(grant),
    refused: (token) => {
      // Keep the token so the library stays selected, but forget the dead
      // refresh token so it isn't retried on every call.
      useAppStore.getState().setAuthToken(token);
      markSignInEnded(token);
    },
    ended: markSignInEnded,
  },
  { renew: (refreshToken) => refreshGrant(refreshToken), now: () => Date.now() },
);
