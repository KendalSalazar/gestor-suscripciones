'use client';

import { session } from './session';

type ErrorPayload = {
  error?: {
    message?: string;
  };
};

type RefreshResponse = {
  accessToken: string;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshPromise: Promise<string> | null = null;

function getApiUrl(path: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!baseUrl) throw new Error('NEXT_PUBLIC_API_URL is not configured');
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  return response.json();
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as ErrorPayload).error;
    if (typeof error?.message === 'string') return error.message;
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  const token = session.getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(getApiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new ApiError(getErrorMessage(payload, 'Request failed'), response.status);
  }

  return payload as T | null;
}

async function requestNewAccessToken(): Promise<string> {
  session.setAccessToken(null);

  const response = await fetch(getApiUrl('/auth/refresh'), {
    method: 'POST',
    credentials: 'include',
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new ApiError(getErrorMessage(payload, 'Session expired'), response.status);
  }

  if (
    typeof payload !== 'object'
    || payload === null
    || !('accessToken' in payload)
    || typeof (payload as RefreshResponse).accessToken !== 'string'
  ) {
    throw new ApiError('Invalid refresh response', response.status);
  }

  const { accessToken } = payload as RefreshResponse;
  session.setAccessToken(accessToken);
  return accessToken;
}

export function refreshSession(): Promise<string> {
  // Share one refresh request between simultaneous callers. Refresh tokens rotate,
  // so parallel requests with the same cookie could invalidate the token family.
  if (!refreshPromise) {
    refreshPromise = requestNewAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}
