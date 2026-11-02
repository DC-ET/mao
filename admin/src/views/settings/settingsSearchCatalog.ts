import { COMPANY_SSO_KEY } from './companySsoConfig'
import { ECP_CONFIG_KEY } from './ecpConfig'
import { settingFieldId, type LocatorField } from './settingsLocator'

/** 公司 SSO 是一条 JSON，页面上拆成多个输入框。搜索按框定位。 */
export const SSO_FIELD_IDS = {
  enabled: 'setting-field-company-sso-enabled',
  domains: 'setting-field-company-sso-domains',
  origins: 'setting-field-company-sso-origins',
  ttl: 'setting-field-company-sso-ttl',
  timeout: 'setting-field-company-sso-timeout',
} as const

/** ECP 飞书登录同样是一条 JSON。 */
export const ECP_FIELD_IDS = {
  enabled: 'setting-field-ecp-enabled',
  appCode: 'setting-field-ecp-app-code',
  baseUrl: 'setting-field-ecp-base-url',
  loginVariant: 'setting-field-ecp-login-variant',
  timeout: 'setting-field-ecp-timeout',
  desktopCallback: 'setting-field-ecp-desktop-callback',
  adminCallback: 'setting-field-ecp-admin-callback',
  channelCallback: 'setting-field-ecp-channel-callback',
  larkAppId: 'setting-field-ecp-lark-app-id',
} as const

export const CONTAINER_INHERIT_FIELD_ID = settingFieldId('runtime.container.inheritHostHosts')
export const CONTAINER_EXTRA_HOSTS_FIELD_ID = settingFieldId('runtime.container.extraHosts')
export const CONTAINER_AUTO_UPGRADE_FIELD_ID = settingFieldId('runtime.container.autoUpgrade')

const SSO_SECTION = 'setting-group-company-sso'
const ECP_SECTION = 'setting-group-ecp'
const HOSTS_SECTION = 'setting-group-container-hosts'
const REBUILD_SECTION = 'setting-group-container-rebuild'

/**
 * 专属面板里的控件。这些项要么不在 system_setting 里逐条存在（JSON 子字段），
 * 要么实际开关不在分类卡片上（容器自动升级）。
 */
export const PANEL_LOCATOR_FIELDS: LocatorField[] = [
  { fieldId: SSO_FIELD_IDS.enabled, sectionId: SSO_SECTION, label: '启用公司 SSO', key: COMPANY_SSO_KEY, detail: 'enabled 公司 SSO' },
  { fieldId: SSO_FIELD_IDS.domains, sectionId: SSO_SECTION, label: '域名白名单', key: COMPANY_SSO_KEY, detail: 'allowedDomains 校验域名' },
  { fieldId: SSO_FIELD_IDS.origins, sectionId: SSO_SECTION, label: '宿主Origin白名单', key: COMPANY_SSO_KEY, detail: 'allowedOrigins 宿主 Origin' },
  { fieldId: SSO_FIELD_IDS.ttl, sectionId: SSO_SECTION, label: '访问令牌 TTL (秒)', key: COMPANY_SSO_KEY, detail: 'accessTtlSeconds' },
  { fieldId: SSO_FIELD_IDS.timeout, sectionId: SSO_SECTION, label: '校验超时 (ms)', key: COMPANY_SSO_KEY, detail: 'timeoutMs 公司 SSO' },
  { fieldId: ECP_FIELD_IDS.enabled, sectionId: ECP_SECTION, label: '启用 ECP 飞书登录', key: ECP_CONFIG_KEY, detail: 'enabled ECP' },
  { fieldId: ECP_FIELD_IDS.appCode, sectionId: ECP_SECTION, label: 'appCode', key: ECP_CONFIG_KEY, detail: 'ECP appCode' },
  { fieldId: ECP_FIELD_IDS.baseUrl, sectionId: ECP_SECTION, label: 'ECP API Base URL', key: ECP_CONFIG_KEY, detail: 'baseUrl' },
  { fieldId: ECP_FIELD_IDS.loginVariant, sectionId: ECP_SECTION, label: 'loginVariant', key: ECP_CONFIG_KEY, detail: 'PARTNER' },
  { fieldId: ECP_FIELD_IDS.timeout, sectionId: ECP_SECTION, label: '请求超时 (ms)', key: ECP_CONFIG_KEY, detail: 'timeoutMs ECP' },
  { fieldId: ECP_FIELD_IDS.desktopCallback, sectionId: ECP_SECTION, label: '桌面回调 URL', key: ECP_CONFIG_KEY, detail: 'desktopCallbackUrl' },
  { fieldId: ECP_FIELD_IDS.adminCallback, sectionId: ECP_SECTION, label: '管理后台回调 URL', key: ECP_CONFIG_KEY, detail: 'adminCallbackUrl' },
  { fieldId: ECP_FIELD_IDS.channelCallback, sectionId: ECP_SECTION, label: '通道公网回调 URL', key: ECP_CONFIG_KEY, detail: 'channelCallbackUrl 点我绑定' },
  { fieldId: ECP_FIELD_IDS.larkAppId, sectionId: ECP_SECTION, label: 'lark App ID', key: ECP_CONFIG_KEY, detail: 'larkAppId LARKSUITE_CLI_APP_ID' },
  {
    fieldId: CONTAINER_INHERIT_FIELD_ID,
    sectionId: HOSTS_SECTION,
    label: '自动继承宿主机 /etc/hosts',
    key: 'runtime.container.inheritHostHosts',
    detail: '容器域名解析 Docker hosts',
  },
  {
    fieldId: CONTAINER_EXTRA_HOSTS_FIELD_ID,
    sectionId: HOSTS_SECTION,
    label: '自定义域名解析规则',
    key: 'runtime.container.extraHosts',
    detail: 'host IP 容器 /etc/hosts',
  },
  {
    fieldId: CONTAINER_AUTO_UPGRADE_FIELD_ID,
    sectionId: REBUILD_SECTION,
    label: '发版后自动重启空闲容器',
    key: 'runtime.container.autoUpgrade',
    detail: '代码版本漂移 自动升级 不重建容器',
  },
]

/** 分组卡片本身可被搜到的补充词。控件级命中仍走 PANEL_LOCATOR_FIELDS。 */
export const SECTION_KEYWORDS: Record<string, string> = {
  'setting-group-shell-env': '系统环境变量 变量名 envKey 全站变量',
  'setting-group-container-rebuild': '重建容器 Docker',
  [SSO_SECTION]: COMPANY_SSO_KEY,
  [ECP_SECTION]: ECP_CONFIG_KEY,
}
