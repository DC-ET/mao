<template>
  <div class="budget-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>用量预算</span>
          <div class="header-actions">
            <span class="card-hint">月度周期（服务器本地时区当月 1 日 00:00 起）；成本单位与模型价格填写一致</span>
            <el-button v-if="canWrite" type="primary" @click="openCreate">新增预算</el-button>
            <el-button @click="fetchRows">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="rows" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无预算，点击右上角新增" :image-size="60" />
        </template>
        <el-table-column label="作用域" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="scopeTagType(row.scope)">{{ scopeLabel(row.scope) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="目标" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.scope === 'GLOBAL'" class="muted">全站</span>
            <span v-else-if="row.targetDeleted" class="muted">已删除（ID {{ row.scopeId }}）</span>
            <span v-else>{{ row.targetName || `ID ${row.scopeId}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="口径" width="90">
          <template #default="{ row }">{{ row.limitType === 'COST' ? '成本' : 'Token' }}</template>
        </el-table-column>
        <el-table-column label="上限" width="130" align="right">
          <template #default="{ row }">{{ formatLimit(row) }}</template>
        </el-table-column>
        <el-table-column label="当期消耗" min-width="200">
          <template #default="{ row }">
            <el-progress
              :percentage="spendPercent(row)"
              :stroke-width="8"
              :show-text="false"
              :color="progressColor(row)"
            />
            <span class="spend-text">
              {{ formatSpend(row) }}（{{ spendPercent(row) }}%）
              <el-tag v-if="row.action === 'BLOCK' && spendPercent(row) >= 100" size="small" type="danger">BLOCK 已生效</el-tag>
              <el-tag v-else-if="spendPercent(row) >= 100" size="small" type="warning">WARN 已越线</el-tag>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.action === 'BLOCK' ? 'danger' : 'warning'">{{ row.action }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.enabled === 1 ? 'success' : 'info'">{{ row.enabled === 1 ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="canWrite" label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button type="primary" link size="small" @click="toggleEnabled(row)">{{ row.enabled === 1 ? '停用' : '启用' }}</el-button>
            <el-button type="danger" link size="small" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <ResponsiveDialog v-if="dialogVisible" v-model="dialogVisible" :title="editing ? '编辑预算' : '新增预算'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="作用域" prop="scope">
          <el-radio-group v-model="form.scope" :disabled="editing">
            <el-radio value="GLOBAL">全局</el-radio>
            <el-radio value="USER">用户</el-radio>
            <el-radio value="AGENT">Agent</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.scope === 'USER'" label="目标用户" prop="scopeId">
          <el-select v-model="form.scopeId" filterable :loading="searching" placeholder="搜索用户" style="width: 100%">
            <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username || `用户 #${u.id}`" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'AGENT'" label="目标 Agent" prop="scopeId">
          <el-select v-model="form.scopeId" filterable :loading="searching" placeholder="搜索 Agent" style="width: 100%">
            <el-option v-for="a in agentOptions" :key="a.id" :label="a.name" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="口径" prop="limitType">
          <el-radio-group v-model="form.limitType">
            <el-radio value="COST">成本</el-radio>
            <el-radio value="TOKENS">Token</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="form.limitType === 'COST' ? '成本上限' : 'Token 上限'" prop="limitInput">
          <el-input-number v-model="form.limitInput" :min="0" :controls="false" :precision="form.limitType === 'COST' ? 2 : 0" style="width: 220px" />
          <span class="form-hint-inline">
            {{ form.limitType === 'COST' ? '成本单位（与模型价格填写一致）；内部按 ×1e6 微单位存储' : '月累计 total_tokens 上限' }}
          </span>
        </el-form-item>
        <el-form-item label="动作" prop="action">
          <el-radio-group v-model="form.action">
            <el-radio value="WARN">WARN（越线提醒）</el-radio>
            <el-radio value="BLOCK">BLOCK（拒绝新任务）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import { formatCost } from '../../utils/llmCallLabels'

interface BudgetRow {
  id?: number
  scope: 'GLOBAL' | 'USER' | 'AGENT'
  scopeId?: number | null
  period?: string | null
  limitType: 'COST' | 'TOKENS'
  limitValue: number
  action: 'WARN' | 'BLOCK'
  enabled?: number
  targetName?: string | null
  targetDeleted?: boolean
  periodSpend?: number | null
}

const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('budget:write'))

const loading = ref(false)
const rows = ref<BudgetRow[]>([])
const dialogVisible = ref(false)
const editing = ref<BudgetRow | null>(null)
const submitting = ref(false)
const searching = ref(false)
const userOptions = ref<Array<{ id: number; username?: string; displayName?: string }>>([])
const agentOptions = ref<Array<{ id: number; name: string }>>([])
const formRef = ref<FormInstance>()

const form = reactive({
  scope: 'GLOBAL' as BudgetRow['scope'],
  scopeId: undefined as number | undefined,
  limitType: 'COST' as BudgetRow['limitType'],
  limitInput: undefined as number | undefined,
  action: 'WARN' as BudgetRow['action'],
  enabled: true
})

const rules: FormRules = {
  scope: [{ required: true, message: '请选择作用域', trigger: 'change' }],
  scopeId: [{
    validator: (_rule, value: number | undefined, callback) => {
      if (form.scope !== 'GLOBAL' && (value == null || value <= 0)) callback(new Error('请选择目标'))
      else callback()
    },
    trigger: 'change'
  }],
  limitInput: [{
    validator: (_rule, value: number | undefined, callback) => {
      if (value == null || !Number.isFinite(value) || value <= 0) callback(new Error('上限必须为正数'))
      else callback()
    },
    trigger: 'blur'
  }],
  action: [{ required: true, message: '请选择动作', trigger: 'change' }]
}

function scopeLabel(scope: string): string {
  return scope === 'GLOBAL' ? '全局' : scope === 'USER' ? '用户' : 'Agent'
}

function scopeTagType(scope: string): 'danger' | 'warning' | 'info' {
  return scope === 'GLOBAL' ? 'danger' : scope === 'USER' ? 'warning' : 'info'
}

/** COST 上限展示：limit_value 为微单位（×1e6），换算为成本单位展示。 */
function formatLimit(row: BudgetRow): string {
  return row.limitType === 'COST'
    ? formatCost(row.limitValue / 1000000)
    : row.limitValue.toLocaleString('zh-CN')
}

function formatSpend(row: BudgetRow): string {
  const spend = row.periodSpend
  if (spend == null) return '-'
  return row.limitType === 'COST' ? formatCost(spend) : spend.toLocaleString('zh-CN')
}

/**
 * 当期消耗占上限比例。两侧口径必须对齐：后端 list() 对 COST 已把 periodSpend 换算成
 * 成本单位，而 limitValue 仍是微单位（×1e6），直接相除比值恒小 1e6、进度条永远 0%。
 * TOKENS 两侧都是 token 原值，无需换算。
 */
function spendPercent(row: BudgetRow): number {
  const spend = row.periodSpend
  if (spend == null || row.limitValue <= 0) return 0
  const limit = row.limitType === 'COST' ? row.limitValue / 1000000 : row.limitValue
  return Math.min(100, Math.round((spend / limit) * 1000) / 10)
}

function progressColor(row: BudgetRow): string {
  const p = spendPercent(row)
  if (p >= 100) return row.action === 'BLOCK' ? '#f56c6c' : '#e6a23c'
  if (p >= 80) return '#e6a23c'
  return '#67c23a'
}

async function fetchRows() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/budgets')
    rows.value = data || []
  } catch { /* 拦截器已提示 */ } finally {
    loading.value = false
  }
}

function resetForm() {
  form.scope = 'GLOBAL'
  form.scopeId = undefined
  form.limitType = 'COST'
  form.limitInput = undefined
  form.action = 'WARN'
  form.enabled = true
}

function openCreate() {
  editing.value = null
  resetForm()
  void loadOptions()
  dialogVisible.value = true
}

function openEdit(row: BudgetRow) {
  editing.value = row
  form.scope = row.scope
  form.scopeId = row.scopeId ?? undefined
  form.limitType = row.limitType
  form.limitInput = row.limitType === 'COST' ? row.limitValue / 1000000 : row.limitValue
  form.action = row.action
  form.enabled = row.enabled === 1
  // 编辑时先拉全量选项，再把目标行预置进去（目标已删除时仍可显示原名）
  void loadOptions().then(() => {
    if (row.scope === 'USER' && row.scopeId != null
      && !userOptions.value.some((u) => u.id === row.scopeId)) {
      userOptions.value = [{ id: row.scopeId, username: row.targetName || undefined, displayName: row.targetName || undefined }, ...userOptions.value]
    } else if (row.scope === 'AGENT' && row.scopeId != null
      && !agentOptions.value.some((a) => a.id === row.scopeId)) {
      agentOptions.value = [{ id: row.scopeId, name: row.targetName || `Agent ${row.scopeId}` }, ...agentOptions.value]
    }
  })
  dialogVisible.value = true
}

function buildPayload() {
  return {
    scope: form.scope,
    scopeId: form.scope === 'GLOBAL' ? null : form.scopeId,
    limitType: form.limitType,
    // COST 由成本单位换算为微单位整数存储；TOKENS 原值
    limitValue: form.limitType === 'COST'
      ? Math.round((form.limitInput ?? 0) * 1000000)
      : Math.round(form.limitInput ?? 0),
    action: form.action,
    enabled: form.enabled ? 1 : 0
  }
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editing.value?.id != null) {
      await api.put(`/admin/budgets/${editing.value.id}`, buildPayload())
      ElMessage.success('预算已更新')
    } else {
      await api.post('/admin/budgets', buildPayload())
      ElMessage.success('预算已创建')
    }
    dialogVisible.value = false
    await fetchRows()
  } catch { /* 拦截器已提示 */ } finally {
    submitting.value = false
  }
}

async function toggleEnabled(row: BudgetRow) {
  const next = row.enabled === 1 ? 0 : 1
  try {
    await api.put(`/admin/budgets/${row.id}`, {
      scope: row.scope,
      scopeId: row.scopeId ?? null,
      limitType: row.limitType,
      limitValue: row.limitValue,
      action: row.action,
      enabled: next
    })
    ElMessage.success(next === 1 ? '预算已启用' : '预算已停用')
    await fetchRows()
  } catch { /* 拦截器已提示 */ }
}

async function removeRow(row: BudgetRow) {
  try {
    await ElMessageBox.confirm(
      `删除后立即生效（含停用行）。确认删除该${scopeLabel(row.scope)}${row.action}预算？`,
      '删除预算',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await api.delete(`/admin/budgets/${row.id}`)
    ElMessage.success('预算已删除')
    await fetchRows()
  } catch { /* 拦截器已提示 */ }
}

/** options 接口无 keyword 参数（返回全量），打开对话框时拉一次 + select 本地过滤。 */
async function loadOptions() {
  searching.value = true
  try {
    const [usersRes, agentsRes] = await Promise.all([
      api.get('/admin/sessions/options/users'),
      api.get('/admin/sessions/options/agents')
    ])
    userOptions.value = usersRes.data || []
    agentOptions.value = agentsRes.data || []
  } catch { /* 拦截器已提示 */ } finally {
    searching.value = false
  }
}

onMounted(() => {
  fetchRows()
})
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.spend-text {
  margin-left: 8px;
  font-size: 12px;
  color: var(--mao-muted);
  white-space: nowrap;
}

.muted {
  color: var(--mao-muted);
}

.form-hint-inline {
  margin-left: 8px;
  font-size: 12px;
  color: var(--mao-muted);
}
</style>
