import { RefreshRejectedError, type GitHubGrant } from './auth';

/**
 * Renewing an expiring GitHub sign-in, without the app's store, so it can be
 * tested on its own. services/authSession wires it to the app.
 *
 * Only applies when GitHub sends a refresh token (token expiry on for the
 * OAuth app; it is off for gitgallery-app). Then the access token lasts eight
 * hours, and the refresh token trades for a new pair and stops working once
 * used (docs.github.com, "Authorizing OAuth apps").
 */

/** Renew this long before the access token runs out. */
export const RENEW_MARGIN_MS = 5 * 60_000;

export type RenewalStore = {
  token(): string | null;
  refresh(): { refreshToken: string; expiresAt: number | null } | null;
  /** Must not resolve until the new pair is on disk. */
  save(grant: GitHubGrant): Promise<void>;
  /** GitHub refused the refresh token: keep the access token, stop renewing, show "Sign in again". */
  refused(token: string): void;
  /** GitHub refused this access token and it can't be renewed. */
  ended(token: string): void;
};

export type RenewalDeps = {
  renew: (refreshToken: string) => Promise<GitHubGrant>;
  now: () => number;
};

export function createRenewer(store: RenewalStore, deps: RenewalDeps) {
  // The old refresh token dies when it is used, so two renewals at once would
  // sign the user out. Everyone waits on the same one.
  let renewal: Promise<string | null> | null = null;

  /**
   * The access token to send now, renewed first when it is about to expire.
   *
   * `rejected` is a token GitHub just answered 401 to: if it is still the
   * current one, renew now whatever its expiry says. If another call already
   * replaced it, the new one is returned without asking GitHub again.
   */
  async function freshToken(options: { rejected?: string | null } = {}): Promise<string | null> {
    const token = store.token();
    if (!token) return null;
    if (options.rejected && options.rejected !== token) return token;
    const refresh = store.refresh();
    if (!refresh) return token;
    const due = !!options.rejected || (refresh.expiresAt != null && refresh.expiresAt - deps.now() < RENEW_MARGIN_MS);
    if (!due) return token;
    if (!renewal) {
      renewal = (async () => {
        try {
          const grant = await deps.renew(refresh.refreshToken);
          // Signed out (or in as someone else) while GitHub was answering.
          if (store.token() !== token) return store.token();
          await store.save(grant);
          return grant.accessToken;
        } catch (error) {
          if (error instanceof RefreshRejectedError && store.token() === token) store.refused(token);
          // Offline: carry on with what we have; the next call tries again.
          return store.token();
        } finally {
          renewal = null;
        }
      })();
    }
    return renewal;
  }

  /**
   * Run a request that takes the token itself (native downloads and uploads),
   * renewing and retrying once if GitHub answers 401.
   */
  async function withFreshToken<T extends { status: number }>(run: (token: string) => Promise<T>): Promise<T> {
    const token = await freshToken();
    if (!token) throw new Error('Not authenticated with GitHub.');
    const first = await run(token);
    if (first.status !== 401) return first;
    const next = await freshToken({ rejected: token });
    if (!next || next === token) {
      store.ended(token);
      return first;
    }
    const second = await run(next);
    if (second.status === 401) store.ended(next);
    return second;
  }

  return { freshToken, withFreshToken };
}
