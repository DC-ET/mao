/** 外部登录身份提供方（`user_external_identity`.`provider`）与账号来源标签的单一映射。 */

export const ECP_PROVIDER = 'ecp';
export const COMPANY_SSO_PROVIDER = 'company_sso';

/** 会写 user_external_identity 的登录方式；其余（LDAP / 飞书）靠密码或 feishu_user_id 判定。 */
export const EXTERNAL_LOGIN_PROVIDERS = [ECP_PROVIDER, COMPANY_SSO_PROVIDER] as const;

export type ExternalAuthSource = 'ECP' | 'COMPANY_SSO';

/** provider → authSource 标签；非外部登录提供方返回 null。 */
export function externalAuthSource(provider: string | null | undefined): ExternalAuthSource | null {
  if (provider === ECP_PROVIDER) return 'ECP';
  if (provider === COMPANY_SSO_PROVIDER) return 'COMPANY_SSO';
  return null;
}

/** SQL IN 列表，取值全部来自本文件常量，可安全拼接。 */
export function externalProviderInList(): string {
  return EXTERNAL_LOGIN_PROVIDERS.map((provider) => `'${provider}'`).join(', ');
}
