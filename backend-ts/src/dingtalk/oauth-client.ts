export interface DingtalkOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oauthConfigured(config: DingtalkOauthConfig): boolean {
  return config.clientId.trim() !== '' && config.clientSecret.trim() !== '' && config.redirectUri.trim() !== '';
}

export function dingtalkAuthorizeUrl(config: DingtalkOauthConfig, state: string): string {
  const url = new URL('https://login.dingtalk.com/oauth2/auth');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export function webOriginOf(redirectUri: string): string | null {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return null;
  }
}

export async function exchangeUserAccessToken(
  fetchImpl: typeof fetch,
  config: DingtalkOauthConfig,
  code: string,
): Promise<string> {
  const response = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      grantType: 'authorization_code',
    }),
  });
  const body = await response.json() as { accessToken?: string; message?: string };
  if (!response.ok || body.accessToken == null || body.accessToken === '') {
    throw new Error(body.message || '钉钉用户 token 交换失败');
  }
  return body.accessToken;
}

export async function fetchUnionId(fetchImpl: typeof fetch, userAccessToken: string): Promise<string> {
  const response = await fetchImpl('https://api.dingtalk.com/v1.0/contact/users/me', {
    headers: { 'x-acs-dingtalk-access-token': userAccessToken },
  });
  const body = await response.json() as { unionId?: string; message?: string };
  if (!response.ok || body.unionId == null || body.unionId === '') {
    throw new Error(body.message || '获取钉钉通讯录个人信息失败');
  }
  return body.unionId;
}

/** 旧版「根据 unionid 查询用户」。应用必须与机器人同一企业。 */
export async function fetchUseridByUnionId(fetchImpl: typeof fetch, legacyToken: string, unionId: string): Promise<string> {
  const response = await fetchImpl(
    `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(legacyToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unionid: unionId }),
    },
  );
  const body = await response.json() as { errcode?: number; errmsg?: string; result?: { userid?: string } };
  const userid = body.result?.userid;
  if (!response.ok || body.errcode !== 0 || userid == null || userid === '') {
    throw new Error(body.errmsg || '根据 unionId 查询钉钉 userid 失败');
  }
  return userid;
}
