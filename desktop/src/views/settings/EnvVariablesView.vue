<template>
  <div class="env-variables-page">
    <div class="page-header">
      <h1 class="page-title">环境变量</h1>
      <p class="page-desc">
        配置后注入你的云端 Agent Shell 与云端终端。LOCAL 模式使用本机环境，不在此配置。
        优先级：工作区 &gt; 用户全局 &gt; 系统全局。保存后数秒内（最多 5 秒）对新执行的命令生效。
      </p>
    </div>

    <div class="hint-card">
      <el-icon :size="14"><InfoFilled /></el-icon>
      <span>
        变量值加密存储，保存后不再回显；<code>PATH</code> / <code>HOME</code> / <code>MAO_TOKEN</code>
        等平台保留变量不可配置。工作区变量请在会话头部的「环境变量」中维护。
      </span>
    </div>

    <button class="create-btn" @click="openCreateDialog">
      <el-icon><Plus /></el-icon>
      新增变量
    </button>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="variables.length === 0" class="empty-state">
      暂无环境变量，点击上方按钮添加
    </div>
    <div v-else class="variable-list">
      <div v-for="item in variables" :key="item.id" class="variable-card">
        <div class="variable-header">
          <div class="variable-key">{{ item.envKey }}</div>
          <div class="variable-actions">
            <template v-if="deletingId === item.id">
              <button class="action-btn action-btn-danger" title="确认删除" @click="confirmDelete(item)">
                <el-icon :size="14"><Check /></el-icon>
              </button>
              <button class="action-btn" title="取消" @click="deletingId = null">
                <el-icon :size="14"><Close /></el-icon>
              </button>
            </template>
            <template v-else>
              <el-tooltip content="编辑" :show-after="300">
                <button class="action-btn" @click="openEditDialog(item)">
                  <el-icon :size="14"><Edit /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="删除" :show-after="300">
                <button class="action-btn action-btn-danger" @click="deletingId = item.id">
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
              </el-tooltip>
            </template>
          </div>
        </div>
        <div class="variable-meta">
          <span class="variable-value">值：****</span>
          <span v-if="item.note" class="variable-note">{{ item.note }}</span>
        </div>
        <div class="variable-time">更新于 {{ formatTime(item.updatedAt) }}</div>
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑环境变量' : '新增环境变量'"
      width="480px"
      class="env-variable-dialog management-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <el-form-item label="变量名" :error="keyError">
          <el-input
            v-model="form.envKey"
            placeholder="如 GITEA_TOKEN、NPM_REGISTRY"
            :disabled="isEditing"
            @input="validateKey"
          />
        </el-form-item>
        <el-form-item label="变量值">
          <el-input
            v-model="form.envValue"
            type="password"
            show-password
            :placeholder="isEditing ? '重新输入变量值（不回显，留空无法保存）' : '变量值'"
          />
        </el-form-item>
        <el-form-item label="备注（选填）">
          <el-input v-model="form.note" placeholder="如：私有 Gitea Token" maxlength="256" />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit || submitting" @click="handleSubmit">
          {{ submitting ? '保存中…' : (isEditing ? '保存' : '创建') }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Plus, Check, Close, Edit, Delete, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

interface EnvVariableItem {
  id: number
  envKey: string
  note?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** 与后端 common/sensitive-env.ts 的保留键清单保持一致（前端只做提示，真正拒绝在服务端）。 */
const RESERVED_PREFIXES = ['GIT_TOKEN_', 'MYSQL_', 'APP_', 'MAO_']
const RESERVED_KEYS = new Set([
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'JWT_SECRET', 'MAO_TOKEN', 'ECP_TOKEN',
  'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_APP_ID', 'HOME', 'PATH', 'PWD', 'OLDPWD',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'TMPDIR', 'IFS',
  'PS1', 'PS2', 'PS4', 'BASH', 'BASHOPTS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PYTHONSTARTUP',
  'PYTHONPATH', 'MAO_TASK_NAME', 'MAO_DEPS_BIN', 'NPM_CONFIG_PREFIX', 'PIP_TARGET',
  'PIP_BREAK_SYSTEM_PACKAGES',
])

const loading = ref(false)
const variables = ref<EnvVariableItem[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const submitting = ref(false)
const keyError = ref('')
const form = ref({ envKey: '', envValue: '', note: '' })

function isReservedKey(key: string): boolean {
  const upper = key.toUpperCase()
  return RESERVED_KEYS.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

function formatTime(value?: string | null) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!form.value.envKey.trim() || !KEY_PATTERN.test(form.value.envKey.trim())) return false
  if (isReservedKey(form.value.envKey.trim())) return false
  // 编辑时值必须重填（服务端不回显，留空无法表达「不修改」）
  if (!form.value.envValue) return false
  return true
})

function validateKey() {
  const key = form.value.envKey.trim()
  if (!key) {
    keyError.value = ''
    return
  }
  if (!KEY_PATTERN.test(key)) {
    keyError.value = '变量名须以字母或下划线开头，仅含字母/数字/下划线，最长 128 字符'
    return
  }
  keyError.value = isReservedKey(key) ? `${key} 为平台保留变量，不允许配置` : ''
}

async function fetchVariables() {
  loading.value = true
  try {
    const { data } = await api.get('/user/env-variables')
    variables.value = data || []
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { envKey: '', envValue: '', note: '' }
  keyError.value = ''
  dialogVisible.value = true
}

function openEditDialog(item: EnvVariableItem) {
  isEditing.value = true
  editingId.value = item.id
  form.value = { envKey: item.envKey, envValue: '', note: item.note || '' }
  keyError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  form.value = { envKey: '', envValue: '', note: '' }
  isEditing.value = false
  editingId.value = null
  keyError.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await api.put(`/user/env-variables/${editingId.value}`, {
        envValue: form.value.envValue,
        note: form.value.note.trim()
      })
      ElMessage.success('变量已更新')
    } else {
      await api.post('/user/env-variables', {
        envKey: form.value.envKey.trim(),
        envValue: form.value.envValue,
        note: form.value.note.trim() || undefined
      })
      ElMessage.success('变量已创建')
    }
    dialogVisible.value = false
    await fetchVariables()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(item: EnvVariableItem) {
  try {
    await api.delete(`/user/env-variables/${item.id}`)
    ElMessage.success(`已删除 ${item.envKey}`)
    deletingId.value = null
    await fetchVariables()
  } catch {
    // handled by interceptor
  }
}

onMounted(() => {
  fetchVariables()
})
</script>

<style scoped>
.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 8px;
}

.page-desc {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.6;
  max-width: 640px;
}

.hint-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 640px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  background: var(--aw-surface);
  color: var(--aw-ink-muted);
  font-size: 12px;
  line-height: 1.6;
}

.hint-card code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--aw-surface-hover);
  font-family: var(--aw-font-mono, monospace);
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
  margin-bottom: 20px;
}

.create-btn:hover {
  opacity: 0.85;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.variable-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 640px;
}

.variable-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 12px 14px;
}

.variable-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.variable-key {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
  font-family: var(--aw-font-mono, monospace);
  word-break: break-all;
}

.variable-actions {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
  cursor: pointer;
}

.action-btn:hover {
  color: var(--aw-ink);
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.variable-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.variable-value {
  font-family: var(--aw-font-mono, monospace);
}

.variable-note {
  color: var(--aw-ink-muted-80);
}

.variable-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--aw-ink-muted);
}

.dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.dialog-btn-confirm {
  margin-left: 8px;
  border-color: var(--aw-primary);
  background: var(--aw-primary);
  color: #fff;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
