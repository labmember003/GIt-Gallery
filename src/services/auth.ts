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
  error?: string;
  error_description?: string;
};

export type DeviceFlowStart = DeviceCodeResponse;

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const params = new URLSearchParams();
  params.append('client_id', GITHUB_CLIENT_ID());
  params.append('scope', GITHUB_SCOPES);

  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error('Failed to start device flow');
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollForToken(deviceCode: string, intervalSec: number, abortSignal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams();
  params.append('client_id', GITHUB_CLIENT_ID());
  params.append('device_code', deviceCode);
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

  while (true) {
    if (abortSignal?.aborted) throw new Error('aborted');
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: abortSignal,
    });
    if (!res.ok) throw new Error('Token request failed');
    const data = (await res.json()) as TokenResponse;
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
      continue;
    }
    if (data.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, (intervalSec + 2) * 1000));
      continue;
    }
    throw new Error(data.error_description || data.error || 'Unknown auth error');
  }
}


