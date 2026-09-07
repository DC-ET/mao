/** POST /api/v1/auth/sso/exchange; JSON body { checkUrl: string }; Authorization: Bearer <SSO token>. */
export interface SsoExchangeVO {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Seconds until proactive renewal. */
  refreshAfter: number;
  user: { id: number; displayName: string };
}
