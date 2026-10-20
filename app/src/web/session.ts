import type { RepoInfo } from '../services/sync/types';

export type WebSession = {
  user: { id: number; login: string; name: string } | null;
  csrf: string;
  selectedRepo: RepoInfo | null;
  expiresAt: number;
  oauthAvailable: boolean;
  signInMethod: 'device' | 'redirect' | null;
  tokenSignInAvailable: boolean;
};
export type Repository = { id: number; fullName: string; description: string | null; private: boolean; branch: string; writable: boolean };
export type DeviceChallenge = {
  method: 'device'; attemptId: string; userCode: string; verificationUri: string; expiresAt: number; interval: number;
};
export type SignInStart = DeviceChallenge | { method: 'redirect'; url: string };
export class SessionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function sessionRequest<T>(path: string, options: { csrf?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { method: options.body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal: options.signal,
    headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', 'X-GitGallery-CSRF': options.csrf ?? '' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new SessionError('The sign-in service is unavailable. Please try again shortly.', response.status);
  const result = await response.json();
  if (!response.ok) throw new SessionError(result.error ?? 'The request could not be completed.', response.status);
  return result as T;
}

/** A GitHub-compatible fetch adapter; authentication stays in the server session. */
export const sessionFetch: typeof fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com' || (options.method && options.method !== 'GET')) throw new Error('Unsupported library request.');
  const response = await fetch(`/api/github${url.pathname}${url.search}`, { method: 'GET', credentials: 'same-origin',
    cache: 'no-store', signal: options.signal, headers: { Accept: new Headers(options.headers).get('Accept') ?? 'application/vnd.github+json' } });
  if (response.status === 401) window.dispatchEvent(new Event('gitgallery:session-expired'));
  return response;
};
