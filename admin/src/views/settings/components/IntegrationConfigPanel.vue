<template>
  <div class="integration-panel">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="集成配置保存后即时生效；Agent 运行 / Harness 调参为启动时构建，保存后需重启后端生效。加密项保存后仅显示掩码，留空表示不修改。"
      class="integration-tip"
    />
    <div class="group-list">
      <el-card
        v-for="group in groups"
        :key="group.name"
        :id="`setting-group-${group.name}`"
        class="group-card"
        shadow="never"
      >
          <template #header>
            <div class="group-header">
              <span class="group-title">{{ group.title }}</span>
              <div class="group-actions">
                <el-button
                  v-if="group.testApi"
                  size="small"
                  :loading="testing === group.name"
                  :disabled="!canWrite"
                  @click="runTest(group)"
                >测试连接</el-button>
                <el-button
                  type="primary"
                  size="small"
                  :loading="savingKeys.has(group.name)"
                  :disabled="!canWrite"
                  @click="saveGroup(group)"
                >保存</el-button>
              </div>
            </div>
          </template>
          <el-form label-width="130px" label-position="left" class="group-form">
            <el-form-item v-for="field in group.fields" :key="field.key" :label="field.label">
              <el-switch
                v-if="field.type === 'switch'"
                :model-value="model[field.key] === 'true'"
                :disabled="!canWrite"
                @change="(val: string | number | boolean) => { model[field.key] = val === true ? 'true' : 'false' }"
              />
              <el-select
                v-else-if="field.type === 'select'"
                v-model="model[field.key]"
                :disabled="!canWrite"
                style="width: 100%"
              >
                <el-option v-for="opt in field.options || []" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
              <el-input-number
                v-else-if="field.type === 'number'"
                :model-value="toNumberOrNull(model[field.key])"
                :min="field.min"
                :max="field.max"
                :step="1"
                step-strictly
                controls-position="right"
                :disabled="!canWrite"
                style="width: 100%"
                @update:model-value="(val: number | undefined) => { model[field.key] = val == null ? '' : String(val) }"
              />
              <el-input
                v-else
                v-model="model[field.key]"
                :type="field.secret ? 'password' : 'text'"
                :placeholder="field.secret ? (field.set ? '已设置，留空表示不修改' : '') : field.placeholder || ''"
                :disabled="!canWrite"
                autocomplete="new-password"
              >
                <template v-if="field.secret && field.set && canWrite" #append>
                  <el-button @click="clearSecret(field.key)">清空</el-button>
                </template>
              </el-input>
              <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
            </el-form-item>
          </el-form>
        </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../api'

interface SettingRow {
  settingKey: string
  value: string | null
  isSecret?: number | null
}

interface FieldDef {
  key: string
  label: string
  type?: 'switch' | 'select' | 'number' | 'text'
  secret?: boolean
  set?: boolean
  placeholder?: string
  hint?: string
  min?: number
  max?: number
  options?: Array<{ label: string; value: string }>
  /** URL 类字段格式校验：非空值必须匹配该正则 */
  pattern?: RegExp
  patternMessage?: string
}

interface GroupDef {
  name: string
  title: string
  keys: string[]
  fields: FieldDef[]
  testApi?: string
  testPayload?: (model: Record<string, string>) => Record<string, string>
}

const props = defineProps<{ rows: SettingRow[]; canWrite?: boolean }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const rowMap = computed<Record<string, SettingRow>>(() => {
  const map: Record<string, SettingRow> = {}
  for (const row of props.rows) map[row.settingKey] = row
  return map
})

/** 表单编辑副本：进入时从 rows 拷贝，保存成功后回写。secret 留空 = 不修改。 */
const model = reactive<Record<string, string>>({})
const savingKeys = ref(new Set<string>())
const testing = ref('')
/** 用户显式点了"清空"的 secret 键：保存时提交 ''（清空语义）而非 null（不修改）。 */
const clearedSecrets = ref(new Set<string>())

function syncFromRows() {
  for (const row of props.rows) {
    if (model[row.settingKey] === undefined) {
      model[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')
    }
  }
}

watch(rowMap, syncFromRows, { immediate: true, deep: true })

const groups = computed<GroupDef[]>(() => [
  {
    name: 'ldap',
    title: 'LDAP 认证',
    keys: ['auth.ldap.enabled', 'auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase'],
    fields: [
      { key: 'auth.ldap.enabled', label: '启用', type: 'switch' },
      { key: 'auth.ldap.url', label: '服务地址', placeholder: 'ldap://或ldaps://开头', pattern: /^ldaps?:\/\//, patternMessage: '需以 ldap:// 或 ldaps:// 开头' },
      { key: 'auth.ldap.baseDn', label: 'Base DN' },
      { key: 'auth.ldap.userDn', label: '绑定账号 DN' },
      { key: 'auth.ldap.password', label: '绑定密码', secret: true, set: !!rowMap.value['auth.ldap.password']?.value },
      { key: 'auth.ldap.userSearchBase', label: '用户搜索 Base', hint: '默认 ou=users' },
    ],
    testApi: '/system-settings/test/ldap',
    testPayload: (m) => pickNonEmpty(m, ['auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase'], ['auth.ldap.url:url', 'auth.ldap.baseDn:baseDn', 'auth.ldap.userDn:userDn', 'auth.ldap.password:password', 'auth.ldap.userSearchBase:userSearchBase']),
  },
  {
    name: 'feishu',
    title: '飞书 OAuth 登录',
    keys: ['auth.feishu.enabled', 'auth.feishu.appId', 'auth.feishu.appSecret', 'auth.feishu.redirectUri'],
    fields: [
      { key: 'auth.feishu.enabled', label: '启用', type: 'switch' },
      { key: 'auth.feishu.appId', label: 'App ID' },
      { key: 'auth.feishu.appSecret', label: 'App Secret', secret: true, set: !!rowMap.value['auth.feishu.appSecret']?.value },
      { key: 'auth.feishu.redirectUri', label: '回调地址', hint: '需与飞书开放平台配置一致', pattern: /^https?:\/\//, patternMessage: '需以 http:// 或 https:// 开头' },
    ],
    testApi: '/system-settings/test/feishu',
    testPayload: (m) => pickNonEmpty(m, ['auth.feishu.appId', 'auth.feishu.appSecret'], ['auth.feishu.appId:appId', 'auth.feishu.appSecret:appSecret']),
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
      { key: 'file.maxSizeMb', label: '单文件上限 (MB)', type: 'number', min: 1, max: 102400 },
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
      { key: 'oss.accessKeySecret', label: 'AccessKey Secret', secret: true, set: !!rowMap.value['oss.accessKeySecret']?.value },
      { key: 'oss.sts.regionId', label: 'STS Region ID' },
      { key: 'oss.sts.endpoint', label: 'STS Endpoint', hint: '如 sts.cn-hangzhou.aliyuncs.com' },
      { key: 'oss.sts.accessKeyId', label: 'STS AccessKey ID' },
      { key: 'oss.sts.accessKeySecret', label: 'STS AccessKey Secret', secret: true, set: !!rowMap.value['oss.sts.accessKeySecret']?.value },
      { key: 'oss.sts.roleArn', label: 'STS Role ARN' },
      { key: 'oss.sts.roleSessionName', label: 'STS 会话名', hint: '默认 mao-sts' },
      { key: 'oss.sts.expire', label: '凭证有效期 (秒)', hint: '默认 3600', type: 'number', min: 60, max: 86400 },
      { key: 'oss.sts.maxSizeMb', label: '直传上限 (MB)', hint: '默认 50', type: 'number', min: 1, max: 51200 },
    ],
    testApi: '/system-settings/test/oss',
    testPayload: (m) => {
      const map: Record<string, string> = {
        'oss.region': 'region',
        'oss.accessKeyId': 'accessKeyId',
        'oss.accessKeySecret': 'accessKeySecret',
        'oss.bucket': 'bucket',
        'oss.sts.regionId': 'stsRegionId',
        'oss.sts.endpoint': 'stsEndpoint',
        'oss.sts.accessKeyId': 'stsAccessKeyId',
        'oss.sts.accessKeySecret': 'stsAccessKeySecret',
        'oss.sts.roleArn': 'stsRoleArn',
      }
      const out: Record<string, string> = {}
      for (const [src, dst] of Object.entries(map)) {
        const value = m[src]
        if (value != null && value.trim() !== '') out[dst] = value
      }
      return out
    },
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
      { key: 'tools.tavilyApiKey', label: 'Tavily API Key', secret: true, set: !!rowMap.value['tools.tavilyApiKey']?.value, hint: '搜索实现为 Tavily 时使用' },
      { key: 'tools.tinyfishApiKey', label: 'TinyFish API Key', secret: true, set: !!rowMap.value['tools.tinyfishApiKey']?.value, hint: '搜索实现为 TinyFish 时使用' },
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
    keys: ['harness.compaction.enabled', 'harness.compaction.contextWindowTokens', 'harness.compaction.triggerRatio', 'harness.compaction.maxSummaryTokens', 'harness.compaction.loopMidwayCompact'],
    fields: [
      { key: 'harness.compaction.enabled', label: '启用', type: 'switch', hint: '会话上下文自动压缩总开关' },
      { key: 'harness.compaction.contextWindowTokens', label: '上下文窗口 (tokens)', type: 'number', min: 1000, max: 10000000, hint: '默认 256000' },
      { key: 'harness.compaction.triggerRatio', label: '触发比例', hint: '0~1 之间的小数，默认 0.8' },
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
      { key: 'harness.webPage.maxOutputLength', label: '输出字符上限', type: 'number', min: 1000, max: 10000000, hint: '默认 500000' },
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
])

function pickNonEmpty(m: Record<string, string>, keys: string[], mapping: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < keys.length; i++) {
    const value = m[keys[i]]
    if (value != null && value.trim() !== '') {
      out[mapping[i].split(':')[1]] = value
    }
  }
  return out
}

/** 标记 secret 待清空：保存时提交空串（后端 ''=清空语义），输入新值则自动覆盖清空标记。 */
function clearSecret(key: string) {
  model[key] = ''
  clearedSecrets.value = new Set([...clearedSecrets.value, key])
}

function toNumberOrNull(raw: string | undefined): number | undefined {
  if (raw == null || String(raw).trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

async function saveGroup(group: GroupDef) {
  if (!props.canWrite) return
  if (savingKeys.value.has(group.name)) return
  // 数值字段校验：非法/越界直接拦截，禁止保存
  for (const field of group.fields) {
    if (field.type !== 'number') continue
    const raw = model[field.key] ?? ''
    if (String(raw).trim() === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || (field.min != null && n < field.min) || (field.max != null && n > field.max)) {
      ElMessage.error(`「${field.label}」需为 ${field.min ?? '任意'} ~ ${field.max ?? '任意'} 之间的数值`)
      return
    }
  }
  // URL 类字段格式校验：留空跳过，非空必须匹配
  for (const field of group.fields) {
    if (!field.pattern) continue
    const raw = (model[field.key] ?? '').trim()
    if (raw === '') continue
    if (!field.pattern.test(raw)) {
      ElMessage.error(`「${field.label}」${field.patternMessage || '格式不正确'}`)
      return
    }
  }
  const items = group.keys.map((key) => {
    const row = rowMap.value[key]
    const raw = model[key] ?? ''
    if (row?.isSecret === 1) {
      // secret 语义：非空=保存新值；空串+点了"清空"=清空已存值；空串未点清空=不修改（null）
      if (raw !== '') return { key, value: raw }
      return { key, value: clearedSecrets.value.has(key) ? '' : null }
    }
    return { key, value: raw }
  })
  savingKeys.value = new Set([...savingKeys.value, group.name])
  try {
    await api.put('/system-settings/batch', { items })
    for (const item of items) {
      const row = rowMap.value[item.key]
      if (row) {
        if (row.isSecret === 1) {
          // ''=已清空；null=未修改保持掩码；新值=掩码
          row.value = item.value === '' ? '' : (item.value == null ? row.value : '******')
          model[item.key] = ''
        } else {
          model[item.key] = item.value ?? ''
          row.value = item.value ?? ''
        }
      }
    }
    // 仅移除本组已保存的键：其他组未保存的「清空」标记必须保留
    const nextCleared = new Set(clearedSecrets.value)
    for (const item of items) nextCleared.delete(item.key)
    clearedSecrets.value = nextCleared
    ElMessage.success('已保存，配置即时生效')
    emit('saved')
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    const next = new Set(savingKeys.value)
    next.delete(group.name)
    savingKeys.value = next
  }
}

async function runTest(group: GroupDef) {
  if (!group.testApi || testing.value || !props.canWrite) return
  testing.value = group.name
  try {
    const payload = group.testPayload ? group.testPayload(model) : {}
    const { data } = await api.post(group.testApi, payload)
    if (data?.ok) {
      ElMessage.success('连接成功')
    } else {
      ElMessage.warning(data?.message || '连接失败')
    }
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    testing.value = ''
  }
}
</script>

<style scoped>
.integration-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.integration-tip {
  border-radius: 8px;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.group-card {
  border-radius: 10px;
  scroll-margin-top: 12px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.group-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--mao-ink);
}

.group-actions {
  display: flex;
  gap: 8px;
}

.group-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.field-hint {
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.4;
  margin-top: 2px;
}
</style>
