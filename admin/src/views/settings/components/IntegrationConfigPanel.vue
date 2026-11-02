<template>
  <div class="integration-panel">
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
            <div v-for="field in group.fields" :id="settingFieldId(field.key)" :key="field.key" class="setting-field">
            <el-form-item :label="field.label">
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
            </div>
          </el-form>
        </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'
import { INTEGRATION_GROUP_CATALOG } from '../integrationFieldCatalog'
import { settingFieldId } from '../settingsLocator'

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

const props = defineProps<{ rows: SettingRow[]; canWrite?: boolean; groupName?: string }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

/** 表单编辑副本：进入时从 rows 拷贝，保存成功后回写。secret 留空 = 不修改。 */
const model = reactive<Record<string, string>>({})
const savingKeys = ref(new Set<string>())
const testing = ref('')
/** 用户显式点了"清空"的 secret 键：保存时提交 ''（清空语义）而非 null（不修改）。 */
const clearedSecrets = ref(new Set<string>())

/**
 * 每个 key 最近一次与服务端对齐的值（secret 恒为 ''）：dirty 判定基线。
 * 刷新语义：本地未触碰的 key 跟随服务端覆盖；已触碰的 key 在服务端未变时保留编辑；
 * 已触碰且服务端变了（他人修改/兄弟面板保存触发刷新拿到新值）→ 弹确认决定丢弃或保留。
 */
const serverBaseline: Record<string, string> = {}
let syncConfirmInFlight = false

function targetOf(row: SettingRow): string {
  return row.isSecret === 1 ? '' : (row.value ?? '')
}

function applyServerValues(keys: string[]): void {
  for (const key of keys) {
    const row = rowMap.value[key]
    if (!row) continue
    const target = targetOf(row)
    model[key] = target
    serverBaseline[key] = target
  }
  if (clearedSecrets.value.size > 0) {
    const next = new Set(clearedSecrets.value)
    for (const key of keys) next.delete(key)
    clearedSecrets.value = next
  }
}

async function confirmDiscardEdits(conflicts: string[]): Promise<void> {
  if (syncConfirmInFlight) return
  syncConfirmInFlight = true
  try {
    await ElMessageBox.confirm(
      `服务端配置已被更新（可能由其他人修改），丢弃 ${conflicts.length} 个未保存的编辑并刷新？`,
      '配置已变更',
      { confirmButtonText: '丢弃并刷新', cancelButtonText: '保留本地编辑', type: 'warning' }
    )
    applyServerValues(conflicts)
  } catch {
    // 保留本地编辑：基线推进到新服务端值，服务端不再变化前不重复打扰
    for (const key of conflicts) {
      const row = rowMap.value[key]
      if (row) serverBaseline[key] = targetOf(row)
    }
  } finally {
    syncConfirmInFlight = false
  }
}

function syncFromRows() {
  const conflicts: string[] = []
  for (const row of visibleRows.value) {
    const key = row.settingKey
    const target = targetOf(row)
    if (!(key in serverBaseline)) {
      // 新出现的 key：直接收编
      model[key] = target
      serverBaseline[key] = target
      continue
    }
    const untouched = (model[key] ?? '') === serverBaseline[key] && !clearedSecrets.value.has(key)
    if (untouched) {
      model[key] = target
      serverBaseline[key] = target
      continue
    }
    if (serverBaseline[key] === target) continue
    conflicts.push(key)
  }
  if (conflicts.length > 0) void confirmDiscardEdits(conflicts)
}

const GROUP_BEHAVIOR: Record<string, Pick<GroupDef, 'testApi' | 'testPayload'>> = {
  ldap: {
    testApi: '/system-settings/test/ldap',
    testPayload: (m) => pickNonEmpty(m, ['auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase'], ['auth.ldap.url:url', 'auth.ldap.baseDn:baseDn', 'auth.ldap.userDn:userDn', 'auth.ldap.password:password', 'auth.ldap.userSearchBase:userSearchBase']),
  },
  feishu: {
    testApi: '/system-settings/test/feishu',
    testPayload: (m) => pickNonEmpty(m, ['auth.feishu.appId', 'auth.feishu.appSecret'], ['auth.feishu.appId:appId', 'auth.feishu.appSecret:appSecret']),
  },
  oss: {
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
}

const ALL_GROUPS = computed<GroupDef[]>(() =>
  INTEGRATION_GROUP_CATALOG.map((group) => ({
    name: group.name,
    title: group.title,
    keys: group.keys,
    ...(GROUP_BEHAVIOR[group.name] ?? {}),
    fields: group.fields.map((field) => ({
      ...field,
      set: field.secret ? !!rowMap.value[field.key]?.value : undefined,
    })),
  })),
)

/** 传 groupName 时只渲染/保存该组（目录分组后每处挂一个实例），否则渲染全部组。 */
const groups = computed<GroupDef[]>(() => {
  const all = ALL_GROUPS.value
  return props.groupName ? all.filter((group) => group.name === props.groupName) : all
})

const visibleRows = computed<SettingRow[]>(() => {
  if (!props.groupName) return props.rows
  const keys = new Set(groups.value.flatMap((group) => group.keys))
  return props.rows.filter((row) => keys.has(row.settingKey))
})

const rowMap = computed<Record<string, SettingRow>>(() => {
  const map: Record<string, SettingRow> = {}
  // 直接取 props.rows：ALL_GROUPS 的 secret set 标记引用 rowMap，若经 visibleRows（依赖 groups→ALL_GROUPS）会成循环依赖
  for (const row of props.rows) map[row.settingKey] = row
  return map
})

watch(visibleRows, syncFromRows, { immediate: true, deep: true })

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
          serverBaseline[item.key] = ''
        } else {
          model[item.key] = item.value ?? ''
          row.value = item.value ?? ''
          serverBaseline[item.key] = item.value ?? ''
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
