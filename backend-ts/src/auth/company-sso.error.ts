export type SsoErrorKind = 'invalid_request' | 'invalid_token' | 'token_expiring' | 'account_forbidden' | 'identity_conflict' | 'rate_limited' | 'service_unavailable';

const ERRORS: Record<SsoErrorKind, { status: number; code: number; message: string }> = {
  invalid_request: { status: 400, code: 1400, message: 'SSO request is invalid' },
  invalid_token: { status: 401, code: 1401, message: 'SSO credential is invalid or expired' },
  token_expiring: { status: 401, code: 1402, message: 'SSO credential expires too soon; obtain a current credential' },
  account_forbidden: { status: 403, code: 1403, message: 'SSO access is forbidden' },
  identity_conflict: { status: 409, code: 1409, message: 'SSO identity conflict; contact an administrator' },
  rate_limited: { status: 429, code: 1429, message: 'SSO exchange rate limited' },
  service_unavailable: { status: 503, code: 1503, message: 'SSO service is unavailable' },
};

export class CompanySsoError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(readonly kind: SsoErrorKind, readonly retryAfter?: number) {
    super(ERRORS[kind].message);
    this.status = ERRORS[kind].status;
    this.code = ERRORS[kind].code;
  }
}
