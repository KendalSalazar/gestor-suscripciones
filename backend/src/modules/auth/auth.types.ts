export type PublicUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthResult = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
};

export type AccessTokenPayload = {
  sub: string;
  email: string;
  type: 'access';
};
