<template>
  <div class="approval-rules-page">
    <div class="page-header">
      <h1 class="page-title">审批规则</h1>
      <p class="page-desc">
        本地任务的工具审批支持「总是允许」：在审批卡片上选择后，同会话内命中该模式的后续调用将自动放行。
        这里是跨会话生效的用户级规则，规则按命中次数排序，命中次数即实际省掉的审批次数。含受保护命令（如 rm、sudo）的命令永远不会被规则放行。
      </p>
    </div>

    <div class="rules-toolbar">
      <div class="type-tabs">
        <button
          v-for="tab in typeTabs"
          :key="tab.value"
          class="type-tab"
          :class="{ active: typeFilter === tab.value }"
          @click="changeType(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>
      <button class="create-btn" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>
        新增规则
      </button>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="items.length === 0" class="empty-state">
      暂无用户级规则，可在审批卡片点击「总是允许」创建会话级规则，或在此手动添加
    </div>
    <div v-else class="rules-list">
      <div v-for="item in items" :key="item.id" class="rule-card" :class="{ disabled: !item.enabled }">
        <div class="rule-main">
          <span class="rule-type-badge" :class="`type-${item.ruleType.toLowerCase()}`">{{ typeLabel(item.ruleType) }}</span>
          <code class="rule-value">{{ item.ruleValue }}</code>
        </div>
        <div class="rule-meta">
          <span class="meta-item">放行 {{ item.hitCount }} 次</span>
          <span class="meta-item">最近命中 {{ formatTime(item.lastHitAt) }}</span>
          <div class="rule-actions">
            <el-switch
              :model-value="item.enabled"
              size="small"
              @change="(v: string | number | boolean) => toggleEnabled(item, v === true)"
            />
            <template v-if="deletingId === item.id">
              <button class="action-text action-text-danger" @click="confirmDelete(item)">确认删除</button>
              <button class="action-text" @click="deletingId = null">取消</button>
            </template>
            <template v-else>
              <button class="action-text" @click="openEditDialog(item)">编辑</button>
              <button class="action-text action-text-danger" @click="deletingId = item.id">删除</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <el-pagination
      v-if="total > pageSize"
      v-model:current-page="page"
      class="rules-pagination"
      layout="prev, pager, next"
      :total="total"
      :page-size="pageSize"
      @current-change="fetchList"
    />

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑规则' : '新增规则'"
      width="480px"
      class="rules-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form label-position="top">
        <el-form-item v-if="!isEditing" label="类型">
          <el-radio-group v-model="form.ruleType">
            <el-radio value="SHELL_PREFIX">命令前缀（前两个词）</el-radio>
            <el-radio value="SHELL_EXACT">完整命令</el-radio>
            <el-radio value="MCP_TOOL">MCP 工具全名</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="isEditing ? '规则值（重新归一化）' : '规则值'">
          <el-input
            v-model="form.ruleValue"
            :placeholder="valuePlaceholder"
            maxlength="512"
            show-word-limit
          />
          <div v-if="normalizedPreview" class="normalized-preview">
            将保存为：<code>{{ normalizedPreview }}</code>
          </div>
          <div class="form-tip">
            前缀规则按「词边界」匹配：保存为 npm run 时放行 npm run build，不会放行 npm runx；
            含受保护命令（rm、sudo 等）的值会被拒绝。
          </div>
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
import { ref, computed, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  listApprovalRules,
  createApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
  type ApprovalRule,
  type ApprovalRuleType
} from '../../api'

const loading = ref(false)
const items = ref<ApprovalRule[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const typeFilter = ref<ApprovalRuleType | ''>('')

const typeTabs: Array<{ value: ApprovalRuleType | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'SHELL_PREFIX', label: '命令前缀' },
  { value: 'SHELL_EXACT', label: '完整命令' },
  { value: 'MCP_TOOL', label: 'MCP 工具' }
]

const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const submitting = ref(false)
const form = ref<{ ruleType: ApprovalRuleType; ruleValue: string }>({
  ruleType: 'SHELL_PREFIX',
  ruleValue: ''
})

const valuePlaceholder = computed(() => {
  if (form.value.ruleType === 'MCP_TOOL') return 'mcp__server__tool'
  if (form.value.ruleType === 'SHELL_EXACT') return '例如：npm run build'
  return '例如：git push origin main（保存为 git push）'
})

const normalizedPreview = computed(() => {
  const raw = form.value.ruleValue.trim()
  if (raw === '') return ''
  if (form.value.ruleType === 'MCP_TOOL') return raw
  // 与服务端一致的前两 token 预览（剥 env 前缀、空白折叠）
  const tokens = raw.split(/\s+/).filter(t => t !== '' && !/^[A-Za-z_][A-Za-z0-9_-]*=/.test(t))
  if (tokens.length === 0) return ''
  return form.value.ruleType === 'SHELL_PREFIX' ? tokens.slice(0, 2).join(' ') : tokens.join(' ')
})

const canSubmit = computed(() => form.value.ruleValue.trim().length > 0 && normalizedPreview.value !== '')

function typeLabel(t: ApprovalRuleType): string {
  switch (t) {
    case 'SHELL_PREFIX': return '前缀'
    case 'SHELL_EXACT': return '全等'
    case 'MCP_TOOL': return 'MCP'
  }
}

function formatTime(value?: string | null) {
  if (!value) return '—'
  return String(value).replace('T', ' ').slice(0, 16)
}

async function fetchList() {
  loading.value = true
  try {
    const result = await listApprovalRules({ page: page.value, pageSize: pageSize.value })
    const records = result.records ?? []
    items.value = typeFilter.value === '' ? records : records.filter(r => r.ruleType === typeFilter.value)
    total.value = result.total ?? 0
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 1
  void fetchList()
}

function changeType(value: ApprovalRuleType | '') {
  typeFilter.value = value
  reload()
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { ruleType: 'SHELL_PREFIX', ruleValue: '' }
  dialogVisible.value = true
}

function openEditDialog(item: ApprovalRule) {
  isEditing.value = true
  editingId.value = item.id
  form.value = { ruleType: item.ruleType, ruleValue: item.ruleValue }
  dialogVisible.value = true
}

function resetForm() {
  isEditing.value = false
  editingId.value = null
  form.value = { ruleType: 'SHELL_PREFIX', ruleValue: '' }
}

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await updateApprovalRule(editingId.value, { ruleValue: form.value.ruleValue.trim() })
      ElMessage.success('规则已更新')
    } else {
      // 重复值提示去重（表无唯一键，服务端允许同值多行）
      const raw = normalizedPreview.value
      if (items.value.some(r => r.ruleType === form.value.ruleType && r.ruleValue === raw)) {
        ElMessage.warning('已存在相同模式的规则')
        submitting.value = false
        return
      }
      const created = await createApprovalRule({ ruleType: form.value.ruleType, ruleValue: form.value.ruleValue.trim() })
      ElMessage.success(`规则已创建：${created.ruleValue}`)
    }
    dialogVisible.value = false
    await fetchList()
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    submitting.value = false
  }
}

async function toggleEnabled(item: ApprovalRule, enabled: boolean) {
  try {
    await updateApprovalRule(item.id, { enabled })
    item.enabled = enabled
    ElMessage.success(enabled ? '规则已启用' : '规则已停用，命中命令将恢复审批')
  } catch {
    // 错误提示由拦截器统一处理
  }
}

async function confirmDelete(item: ApprovalRule) {
  try {
    await deleteApprovalRule(item.id)
    ElMessage.success('已删除')
    deletingId.value = null
    if (items.value.length === 1 && page.value > 1) {
      page.value -= 1
    }
    await fetchList()
  } catch {
    // 错误提示由拦截器统一处理
  }
}

onMounted(() => {
  void fetchList()
})
</script>

<style scoped>
.approval-rules-page {
  max-width: 760px;
}

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
  line-height: 1.5;
  max-width: 560px;
}

.rules-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.type-tabs {
  display: flex;
  gap: 4px;
}

.type-tab {
  padding: 4px 12px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.type-tab:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.type-tab.active {
  color: var(--aw-primary);
  background: var(--aw-accent-bg);
  font-weight: 500;
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
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

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 12px 14px;
}

.rule-card.disabled {
  opacity: 0.6;
}

.rule-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.rule-type-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
  flex-shrink: 0;
}

.rule-type-badge.type-shell_prefix {
  background: var(--aw-accent-bg);
  color: var(--aw-primary);
}

.rule-value {
  font-family: var(--aw-font-mono);
  font-size: 13px;
  color: var(--aw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.rule-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.meta-item {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.rule-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.action-text {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: var(--aw-ink-muted);
  cursor: pointer;
}

.action-text:hover {
  color: var(--aw-ink);
}

.action-text-danger:hover {
  color: var(--aw-danger);
}

.rules-pagination {
  margin-top: 16px;
  justify-content: center;
}

.normalized-preview {
  margin-top: 6px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.normalized-preview code {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

.form-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.5;
}

.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .rules-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .create-btn {
    align-self: flex-end;
  }

  .rule-actions {
    margin-left: 0;
  }
}
</style>

<style>
.rules-dialog {
  --el-font-size-base: 13px;
  --el-font-size-small: 12px;
}

.rules-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}

.rules-dialog .el-form-item__label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 4px !important;
}
</style>
