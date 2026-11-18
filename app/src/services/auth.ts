import { GITHUB_CLIENT_ID, GITHUB_SCOPES } from '@/services/config';

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  /** Sent when the OAuth app issues expiring tokens. */
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
};

/**
 * What GitHub hands back on sign-in.
 *
 * The gitgallery-app OAuth app issues expiring tokens (✅ docs.github.com,
 * "Authorizing OAuth apps"; measured 2026-11-18): the access token lasts eight
 * hours and comes with a refresh token that lasts six months from its last
 * use. Keeping only the access token signed everyone out after eight hours.
 * Long-lived tokens have no refresh token and no expiry, so both are optional.
 */
export type GitHubGrant = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when the access token stops working, if it expires. */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
};

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

function grantFrom(data: TokenResponse, at: number): GitHubGrant {
  const expiresIn = seconds(data.expires_in);
  const refreshExpiresIn = seconds(data.refresh_token_expires_in);
  return {
    accessToken: data.access_token as string,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
    expiresAt: expiresIn == null ? null : at + expiresIn * 1000,
    refreshExpiresAt: refreshExpiresIn == null ? null : at + refreshExpiresIn * 1000,
  };
}

/** GitHub refused the refresh token: only signing in again helps. */
export class RefreshRejectedError extends Error {}

export type DeviceFlowStart = DeviceCodeResponse;

/**
 * Why sign-in stopped, in terms the screen can act on.
 *
 * The screen used to print "Could not start GitHub Device Flow" for every
 * failure, including the common one: on iPhone, opening GitHub in the browser
 * suspends the app, the in-flight poll dies with a network error, and the user
 * then approved a code the app had already given up on.
 */
export type DeviceFlowErrorKind =
  | 'start-failed'
  | 'expired'
  | 'denied'
  | 'disabled'
  | 'misconfigured'
  | 'cancelled';

export class DeviceFlowError extends Error {
  kind: DeviceFlowErrorKind;
  constructor(kind: DeviceFlowErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

type FetchLike = (input: string, init?: any) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;

export async function startDeviceFlow(fetchImpl: FetchLike = fetch): Promise<DeviceFlowStart> {
  const params = new URLSearchParams();
  params.append('client_id', GITHUB_CLIENT_ID());
  params.append('scope', GITHUB_SCOPES);

  let res: Response;
  try {
    res = await fetchImpl('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
  } catch (error: any) {
    throw new DeviceFlowError('start-failed', error?.message ?? 'Network request failed');
  }
  const data = (await res.json().catch(() => ({}))) as Partial<DeviceCodeResponse> & { error?: string };
  if (data?.error === 'device_flow_disabled') {
    throw new DeviceFlowError('disabled', 'Device flow is not enabled for this OAuth app');
  }
  if (!res.ok || !data?.device_code || !data.user_code) {
    throw new DeviceFlowError('start-failed', data?.error ?? `GitHub answered ${res.status}`);
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri ?? 'https://github.com/login/device',
    verification_uri_complete: data.verification_uri_complete,
    expires_in: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

export type PollOptions = {
  intervalSec: number;
  /** Seconds the code stays valid, from the device-code response. */
  expiresInSec?: number;
  signal?: AbortSignal;
  /**
   * Resolves early to poll right away instead of waiting out the interval.
   * The sign-in screen fires it when the app comes back to the foreground, so
   * returning from the browser signs in at once.
   */
  wake?: () => Promise<void>;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal, wake?: () => Promise<void>) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal, wake?: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish);
    wake?.().then(finish, finish);
  });
}

/**
 * Poll GitHub until the user approves the code.
 *
 * Network errors are not fatal. A request that fails while the app is in the
 * background (iOS suspends it as soon as the browser opens) is simply retried,
 * until the code itself expires. Only GitHub's own answers end the loop.
 */
export async function pollForToken(deviceCode: string, options: PollOptions): Promise<GitHubGrant> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + (options.expiresInSec ?? 900) * 1000;
  let intervalSec = Math.max(1, options.intervalSec || 5);

  const params = new URLSearchParams();
  params.append('client_id', GITHUB_CLIENT_ID());
  params.append('device_code', deviceCode);
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

  // GitHub rejects a poll sent before the interval has passed, so even the
  // first one waits.
  while (true) {
    if (options.signal?.aborted) throw new DeviceFlowError('cancelled', 'Sign-in cancelled');
    if (now() >= deadline) throw new DeviceFlowError('expired', 'The code expired');
    await sleep(intervalSec * 1000, options.signal, options.wake);
    if (options.signal?.aborted) throw new DeviceFlowError('cancelled', 'Sign-in cancelled');

    let data: TokenResponse;
    // A request frozen by a suspension can hang instead of failing; cap it so
    // the loop always comes round again.
    const requestAbort = new AbortController();
    const requestTimer = setTimeout(() => requestAbort.abort(), options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: params.toString(),
        signal: requestAbort.signal,
      });
      data = (await res.json()) as TokenResponse;
    } catch {
      // Offline, suspended, timed out, or the connection was torn down
      // mid-request. Keep the code alive and try again on the next tick.
      continue;
    } finally {
      clearTimeout(requestTimer);
    }

    if (data.access_token) return grantFrom(data, now());
    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // docs.github.com: 5 seconds are added to the interval; the response
        // carries the new value.
        intervalSec = typeof data.interval === 'number' && data.interval > intervalSec ? data.interval : intervalSec + 5;
        continue;
      case 'expired_token':
      case 'token_expired':
        throw new DeviceFlowError('expired', 'The code expired');
      case 'access_denied':
        throw new DeviceFlowError('denied', 'Access was denied on GitHub');
      case 'device_flow_disabled':
        throw new DeviceFlowError('disabled', 'Device flow is not enabled for this OAuth app');
      case 'incorrect_client_credentials':
      case 'incorrect_device_code':
      case 'unsupported_grant_type':
        throw new DeviceFlowError('misconfigured', data.error_description || data.error);
      default:
        // An unknown or empty answer (a captive portal page, a proxy error)
        // is treated like a network blip rather than a verdict.
        continue;
    }
  }
}

/**
 * Trade a refresh token for a new access and refresh token. Once used, the old
 * pair stops working (docs.github.com), so callers must store the result before
 * anything else can use the old one. Device Flow tokens need no client secret.
 *
 * Throws `RefreshRejectedError` when GitHub answers with an error (expired or
 * revoked refresh token) and a plain Error when GitHub couldn't be reached, so
 * a phone that is offline doesn't sign itself out.
 */
export async function refreshGrant(
  refreshToken: string,
  options: { fetchImpl?: FetchLike; now?: () => number; requestTimeoutMs?: number } = {},
): Promise<GitHubGrant> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const params = new URLSearchParams();
  params.append('client_id', GITHUB_CLIENT_ID());
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  let data: TokenResponse;
  try {
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: abort.signal,
    });
    data = (await res.json()) as TokenResponse;
  } catch {
    throw new Error('Could not reach GitHub to renew the sign-in');
  } finally {
    clearTimeout(timer);
  }
  if (data.access_token) return grantFrom(data, now());
  if (typeof data.error === 'string' && data.error) throw new RefreshRejectedError(data.error_description || data.error);
  throw new Error('GitHub sent an unexpected answer while renewing the sign-in');
}
