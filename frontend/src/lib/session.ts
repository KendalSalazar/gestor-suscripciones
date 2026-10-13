'use client';

let accessToken: string | null = null;

export const session = {
  getAccessToken: (): string | null => accessToken,
  setAccessToken: (token: string | null): void => {
    accessToken = token;
  },
};
