<template>
  <section id="setting-group-shell-env" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">Shell 环境变量</span>
          <el-button type="primary" size="small" :disabled="!canWrite" @click="openCreate">新增变量</el-button>
        </div>
      </template>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="系统变量对全部用户生效，优先级最低（用户与工作区配置可覆盖）。保存后数秒内（最多 5 秒）对新执行的命令生效。值加密存储，保存后不回显。"
        class="config-tip"
      />

      <el-table :data="rows" v-loading="loading" size="small" stripe>
        <template #empty><el-empty description="暂无系统环境变量" :image-size="48" /></template>
        <el-table-column prop="envKey" label="变量名" min-width="180" show-overflow-tooltip />
        <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.note || '-' }}</template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" width="170" :formatter="formatTimeColumn" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" :disabled="!canWrite" @click="openEdit(row)">编辑</el-button>
            <el-button type="danger" link size="small" :disabled="!canWrite" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-dialog
        v-model="dialogVisible"
        :title="editingId == null ? '新增系统环境变量' : '编辑系统环境变量'"
        width="480px"
        append-to-body
        destroy-on-close
        @closed="resetForm"
      >
        <el-form label-position="top">
          <el-form-item label="变量名" :error="keyError">
            <el-input v-model="form.envKey" :disabled="editingId != null" placeholder="如 ARTIFACTORY_URL" @input="validateKey" />
          </el-form-item>
          <el-form-item label="变量值">
            <el-input
              v-model="form.envValue"
              type="password"
              show-password
              :placeholder="editingId != null ? '重新输入变量值（不回显）' : '变量值'"
            />
          </el-form-item>
          <el-form-item label="备注（选填）">
            <el-input v-model="form.note" maxlength="256" placeholder="如：内网 npm 镜像" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">保存</el-button>
        </template>
      </el-dialog>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'

defineProps<{ canWrite: boolean }>()

interface SystemEnvRow {
  id: number
  envKey: string
  note?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
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

const rows = ref<SystemEnvRow[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const keyError = ref('')
const form = ref({ envKey: '', envValue: '', note: '' })

function isReservedKey(key: string): boolean {
  const upper = key.toUpperCase()
  return RESERVED_KEYS.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

function validateKey() {
  const key = form.value.envKey.trim()
  if (!key) { keyError.value = ''; return }
  if (!KEY_PATTERN.test(key)) {
    keyError.value = '变量名须以字母或下划线开头，仅含字母/数字/下划线，最长 128 字符'
    return
  }
  keyError.value = isReservedKey(key) ? `${key} 为平台保留变量，不允许配置` : ''
}

const canSubmit = computed(() => {
  if (submitting.value) return false
  const key = form.value.envKey.trim()
  if (!key || !KEY_PATTERN.test(key) || isReservedKey(key)) return false
  return form.value.envValue !== ''
})

async function fetchRows() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/system-env-variables')
    rows.value = data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  form.value = { envKey: '', envValue: '', note: '' }
  keyError.value = ''
  dialogVisible.value = true
}

function openEdit(row: SystemEnvRow) {
  editingId.value = row.id
  form.value = { envKey: row.envKey, envValue: '', note: row.note || '' }
  keyError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  editingId.value = null
  form.value = { envKey: '', envValue: '', note: '' }
  keyError.value = ''
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    if (editingId.value == null) {
      await api.post('/admin/system-env-variables', {
        envKey: form.value.envKey.trim(),
        envValue: form.value.envValue,
        note: form.value.note.trim() || undefined,
      })
      ElMessage.success('系统变量已创建')
    } else {
      await api.put(`/admin/system-env-variables/${editingId.value}`, {
        envValue: form.value.envValue,
        note: form.value.note.trim(),
      })
      ElMessage.success('系统变量已更新')
    }
    dialogVisible.value = false
    await fetchRows()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '保存失败')
  } finally {
    submitting.value = false
  }
}

async function remove(row: SystemEnvRow) {
  try {
    await ElMessageBox.confirm(`确定删除系统变量 ${row.envKey} 吗？`, '删除环境变量', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/admin/system-env-variables/${row.id}`)
    ElMessage.success('已删除')
    await fetchRows()
  } catch { /* 拦截器已提示失败 */ }
}

function formatTimeColumn(_row: unknown, _column: unknown, value?: string | null) {
  return value ? value.replace('T', ' ').slice(0, 16) : '-'
}

onMounted(() => {
  void fetchRows()
})
</script>

<style scoped>
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; }
.config-tip { margin-bottom: 12px; }
</style>
