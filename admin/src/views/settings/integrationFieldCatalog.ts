/**
 * 集成配置各组的字段文案。表单（IntegrationConfigPanel）与系统设置搜索共用，
 * 避免搜索索引和页面上的标签各写一份。
 */
export interface IntegrationFieldSpec {
  key: string
  label: string
  type?: 'switch' | 'select' | 'number' | 'text'
  secret?: boolean
  placeholder?: string
  hint?: string
  min?: number
  max?: number
  options?: Array<{ label: string; value: string }>
  pattern?: RegExp
  patternMessage?: string
}

export interface IntegrationGroupSpec {
  name: string
  title: string
  keys: string[]
  fields: IntegrationFieldSpec[]
}

export const INTEGRATION_GROUP_CATALOG: IntegrationGroupSpec[] = [
  {
    name: 'password',
    title: '账号密码登录',
    keys: ['auth.password.enabled'],
    fields: [
      {
        key: 'auth.password.enabled',
        label: '启用账号密码登录',
        type: 'switch',
        hint: '默认开启。关闭后只影响桌面 / Web / 安卓和 mao auth login（含 LDAP）。管理后台登录页始终保留用户名密码，方便 admin 账号进入。已登录会话不受影响。关闭前须已启用飞书 OAuth（真实 App ID）或 ECP 飞书登录，否则桌面端将没有入口，无法保存。',
      },
    ],
  },
  {
    name: 'ldap',
    title: 'LDAP 认证',
    keys: ['auth.ldap.enabled', 'auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase'],
    fields: [
      { key: 'auth.ldap.enabled', label: '启用', type: 'switch' },
      { key: 'auth.ldap.url', label: '服务地址', placeholder: 'ldap://或ldaps://开头', pattern: /^ldaps?:\/\//, patternMessage: '需以 ldap:// 或 ldaps:// 开头' },
      { key: 'auth.ldap.baseDn', label: 'Base DN' },
      { key: 'auth.ldap.userDn', label: '绑定账号 DN' },
      { key: 'auth.ldap.password', label: '绑定密码', secret: true },
      { key: 'auth.ldap.userSearchBase', label: '用户搜索 Base', hint: '默认 ou=users' },
    ],
  },
  {
    name: 'feishu',
    title: '飞书 OAuth 登录',
    keys: ['auth.feishu.enabled', 'auth.feishu.appId', 'auth.feishu.appSecret', 'auth.feishu.redirectUri'],
    fields: [
      { key: 'auth.feishu.enabled', label: '启用', type: 'switch' },
      { key: 'auth.feishu.appId', label: 'App ID' },
      { key: 'auth.feishu.appSecret', label: 'App Secret', secret: true },
      { key: 'auth.feishu.redirectUri', label: '回调地址', hint: '需与飞书开放平台配置一致', pattern: /^https?:\/\//, patternMessage: '需以 http:// 或 https:// 开头' },
    ],
  },
  {
    name: 'dingtalk',
    title: '钉钉 OAuth 登录',
    keys: ['dingtalk.oauth.clientId', 'dingtalk.oauth.clientSecret', 'dingtalk.oauth.redirectUri'],
    fields: [
      { key: 'dingtalk.oauth.clientId', label: 'Client ID', hint: '绑定用登录应用，须与机器人同一企业' },
      { key: 'dingtalk.oauth.clientSecret', label: 'Client Secret', secret: true },
      { key: 'dingtalk.oauth.redirectUri', label: '回调地址', hint: '需与钉钉开放平台「登录与分享」配置一致', pattern: /^https?:\/\//, patternMessage: '需以 http:// 或 https:// 开头' },
    ],
  },
  {
    name: 'upload',
    title: '上传配置',
    keys: ['upload.storageMode', 'upload.baseUrl', 'file.maxSizeMb'],
    fields: [
      {
        key: 'upload.storageMode',
        label: '存储模式',
        type: 'select',
        options: [
          { label: '本地存储', value: 'local' },
          { label: '阿里云 OSS 直传', value: 'oss' },
        ],
      },
      { key: 'upload.baseUrl', label: '访问基础地址', hint: '留空使用相对路径 /uploads/', pattern: /^https?:\/\//, patternMessage: '需以 http:// 或 https:// 开头' },
      { key: 'file.maxSizeMb', label: '单文件上限 (MB)', type: 'number', min: 1, max: 102400, hint: '默认 1024（1GB）' },
    ],
  },
  {
    name: 'site',
    title: '站点',
    keys: ['site.baseUrl'],
    fields: [
      {
        key: 'site.baseUrl',
        label: '站点根地址',
        placeholder: 'https://mao.example.com',
        hint: 'IM 卡片「会话详情」等网页深链的域名来源；留空回落「上传基础地址」',
        pattern: /^https?:\/\//,
        patternMessage: '需以 http:// 或 https:// 开头',
      },
    ],
  },
  {
    name: 'oss',
    title: 'OSS 对象存储',
    keys: ['oss.region', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.bucket', 'oss.sts.regionId', 'oss.sts.endpoint', 'oss.sts.accessKeyId', 'oss.sts.accessKeySecret', 'oss.sts.roleArn', 'oss.sts.roleSessionName', 'oss.sts.expire', 'oss.sts.maxSizeMb'],
    fields: [
      { key: 'oss.region', label: 'Region' },
      { key: 'oss.bucket', label: 'Bucket' },
      { key: 'oss.accessKeyId', label: 'AccessKey ID' },
      { key: 'oss.accessKeySecret', label: 'AccessKey Secret', secret: true },
      { key: 'oss.sts.regionId', label: 'STS Region ID' },
      { key: 'oss.sts.endpoint', label: 'STS Endpoint', hint: '如 sts.cn-hangzhou.aliyuncs.com' },
      { key: 'oss.sts.accessKeyId', label: 'STS AccessKey ID' },
      { key: 'oss.sts.accessKeySecret', label: 'STS AccessKey Secret', secret: true },
      { key: 'oss.sts.roleArn', label: 'STS Role ARN' },
      { key: 'oss.sts.roleSessionName', label: 'STS 会话名', hint: '默认 mao-sts' },
      { key: 'oss.sts.expire', label: '凭证有效期 (秒)', hint: '默认 3600', type: 'number', min: 60, max: 86400 },
      { key: 'oss.sts.maxSizeMb', label: '直传上限 (MB)', hint: '默认 50', type: 'number', min: 1, max: 51200 },
    ],
  },
  {
    name: 'tools',
    title: '网络工具',
    keys: ['tools.webSearchProvider', 'tools.tavilyApiKey', 'tools.tinyfishApiKey'],
    fields: [
      {
        key: 'tools.webSearchProvider',
        label: '搜索实现',
        type: 'select',
        options: [
          { label: 'Tavily（默认）', value: 'tavily' },
          { label: 'TinyFish', value: 'tinyfish' },
        ],
        hint: 'Web 搜索（web_search 工具）的底层实现，保存后即时生效',
      },
      { key: 'tools.tavilyApiKey', label: 'Tavily API Key', secret: true, hint: '搜索实现为 Tavily 时使用' },
      { key: 'tools.tinyfishApiKey', label: 'TinyFish API Key', secret: true, hint: '搜索实现为 TinyFish 时使用' },
    ],
  },
  {
    name: 'agent',
    title: 'Agent 运行',
    keys: ['agent.threadPoolSize', 'agent.threadPoolMax', 'agent.threadPoolQueue', 'ws.idleTimeoutMs'],
    fields: [
      { key: 'agent.threadPoolSize', label: '线程池核心数', type: 'number', min: 1, max: 10000, hint: '默认 20，重启后端后生效' },
      { key: 'agent.threadPoolMax', label: '线程池最大数', type: 'number', min: 1, max: 10000, hint: '默认 100，重启后端后生效' },
      { key: 'agent.threadPoolQueue', label: '线程池队列容量', type: 'number', min: 1, max: 100000, hint: '默认 200，重启后端后生效' },
      { key: 'ws.idleTimeoutMs', label: 'WS 空闲超时 (ms)', type: 'number', min: 1000, max: 3600000, hint: '默认 90000，重启后端后生效' },
    ],
  },
  {
    name: 'notify',
    title: '任务通知',
    keys: ['notify.workerDelayMs', 'notify.batchSize', 'notify.maxAttempts'],
    fields: [
      { key: 'notify.workerDelayMs', label: '轮询间隔 (ms)', type: 'number', min: 1000, max: 3600000, hint: '默认 30000，保存后即时生效' },
      { key: 'notify.batchSize', label: '每轮批量拉取条数', type: 'number', min: 1, max: 10000, hint: '默认 100，保存后即时生效' },
      { key: 'notify.maxAttempts', label: '最大重试次数', type: 'number', min: 1, max: 100, hint: '默认 4，保存后即时生效' },
    ],
  },
  {
    name: 'harness-compaction',
    title: '上下文压缩',
    keys: ['harness.compaction.enabled', 'harness.compaction.contextWindowTokens', 'harness.compaction.triggerRatio', 'harness.compaction.triggerPayloadBytes', 'harness.compaction.maxSummaryTokens', 'harness.compaction.loopMidwayCompact'],
    fields: [
      { key: 'harness.compaction.enabled', label: '启用', type: 'switch', hint: '会话上下文自动压缩总开关' },
      { key: 'harness.compaction.contextWindowTokens', label: '上下文窗口 (tokens)', type: 'number', min: 1000, max: 10000000, hint: '默认 256000' },
      { key: 'harness.compaction.triggerRatio', label: '触发比例', hint: '0~1 之间的小数，默认 0.8' },
      { key: 'harness.compaction.triggerPayloadBytes', label: '请求体体积阈值 (字节)', type: 'number', min: 0, max: 2000000000, hint: '默认 41943040（40 MiB）；0 表示关闭体积触发' },
      { key: 'harness.compaction.maxSummaryTokens', label: '摘要上限 (tokens)', type: 'number', min: 1000, max: 1000000, hint: '默认 12000' },
      { key: 'harness.compaction.loopMidwayCompact', label: '循环中途压缩', type: 'switch', hint: '默认开启' },
    ],
  },
  {
    name: 'harness-llm',
    title: 'LLM 超时与重试',
    keys: ['harness.llm.rateLimitMaxRetries', 'harness.llm.rateLimitRetryDelaySeconds', 'harness.llm.rateLimitMaxRetryDelaySeconds', 'harness.llm.callTimeoutSeconds', 'harness.llm.httpCallTimeoutSeconds', 'harness.llm.streamIdleTimeoutSeconds'],
    fields: [
      { key: 'harness.llm.rateLimitMaxRetries', label: '限流最大重试次数', type: 'number', min: 1, max: 100, hint: '默认 10' },
      { key: 'harness.llm.rateLimitRetryDelaySeconds', label: '限流重试基础间隔 (s)', type: 'number', min: 1, max: 600, hint: '默认 2' },
      { key: 'harness.llm.rateLimitMaxRetryDelaySeconds', label: '限流重试最大间隔 (s)', type: 'number', min: 1, max: 3600, hint: '默认 30' },
      { key: 'harness.llm.callTimeoutSeconds', label: '单次调用超时 (s)', type: 'number', min: 1, max: 3600, hint: '默认 120' },
      { key: 'harness.llm.httpCallTimeoutSeconds', label: 'HTTP 请求超时 (s)', type: 'number', min: 1, max: 3600, hint: '默认 180' },
      { key: 'harness.llm.streamIdleTimeoutSeconds', label: '流式空闲超时 (s)', type: 'number', min: 1, max: 3600, hint: '默认 300' },
    ],
  },
  {
    name: 'harness-webpage',
    title: '网页抓取',
    keys: ['harness.webPage.connectTimeout', 'harness.webPage.readTimeout', 'harness.webPage.maxRawBytes', 'harness.webPage.maxOutputLength', 'harness.webPage.userAgent'],
    fields: [
      { key: 'harness.webPage.connectTimeout', label: '连接超时 (ms)', type: 'number', min: 1000, max: 120000, hint: '默认 10000' },
      { key: 'harness.webPage.readTimeout', label: '读取超时 (ms)', type: 'number', min: 1000, max: 600000, hint: '默认 30000' },
      { key: 'harness.webPage.maxRawBytes', label: '原始内容上限 (字节)', type: 'number', min: 1024, max: 104857600, hint: '默认 1048576 (1MB)' },
      { key: 'harness.webPage.maxOutputLength', label: '输出字符上限', type: 'number', min: 1000, max: 10000000, hint: '默认 50000，超出部分写入 runtime 临时文件可回读' },
      { key: 'harness.webPage.userAgent', label: 'User-Agent' },
    ],
  },
  {
    name: 'harness-shell',
    title: 'Shell 会话',
    keys: ['harness.shell.maxSessionsPerConversation', 'harness.shell.sessionIdleTimeoutMinutes', 'harness.shell.sessionMaxLifetimeHours'],
    fields: [
      { key: 'harness.shell.maxSessionsPerConversation', label: '每会话最大 Shell 数', type: 'number', min: 1, max: 1000, hint: '默认 30' },
      { key: 'harness.shell.sessionIdleTimeoutMinutes', label: '空闲超时 (分钟)', type: 'number', min: 1, max: 1440, hint: '默认 30' },
      { key: 'harness.shell.sessionMaxLifetimeHours', label: '最长存活 (小时)', type: 'number', min: 1, max: 168, hint: '默认 2' },
    ],
  },
  {
    name: 'terminal',
    title: '云端终端',
    keys: ['terminal.maxSessionsPerTask', 'terminal.maxSessionsGlobal', 'terminal.idleTimeoutMinutes', 'terminal.maxLifetimeHours', 'terminal.outputBufferBytes'],
    fields: [
      { key: 'terminal.maxSessionsPerTask', label: '每任务终端上限', type: 'number', min: 1, max: 100, hint: '默认 5' },
      { key: 'terminal.maxSessionsGlobal', label: '全局终端上限', type: 'number', min: 1, max: 1000, hint: '默认 50' },
      { key: 'terminal.idleTimeoutMinutes', label: '空闲回收 (分钟)', type: 'number', min: 1, max: 10080, hint: '默认 120' },
      { key: 'terminal.maxLifetimeHours', label: '最长存活 (小时)', type: 'number', min: 1, max: 720, hint: '默认 24' },
      { key: 'terminal.outputBufferBytes', label: '输出缓冲上限 (字节)', type: 'number', min: 1024, max: 10485760, hint: '默认 262144 (256KB)' },
    ],
  },
]
