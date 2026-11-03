<template>
  <div class="approval-rules-page">
    <div class="page-header">
      <h1 class="page-title">审批规则</h1>
      <p class="page-desc">
        本地任务的工具审批支持「总是允许」：在审批卡片上选择后，同会话内命中该模式的后续调用将自动放行。
        用户级规则跨会话生效；会话内点过的「总是允许」可在「会话级规则」中查看、提升为用户级或删除（恢复审批）。
        规则按命中次数排序，命中次数即实际省掉的审批次数。含受保护命令（如 rm、sudo）的命令永远不会被规则放行。
      </p>
    </div>

    <div class="scope-tabs">
      <button class="scope-tab" :class="{ active: scopeFilter === 'USER' }" @click="changeScope('USER')">用户级规则</button>
      <button class="scope-tab" :class="{ active: scopeFilter === 'SESSION' }" @click="changeScope('SESSION')">会话级规则</button>
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
      <el-input
        v-model="keyword"
        class="rules-search"
        placeholder="搜索规则值"
        clearable
        :prefix-icon="Search"
      />
      <button v-if="scopeFilter === 'USER'" class="create-btn" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>
        新增规则
      </button>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="visibleItems.length === 0 && searching" class="empty-state">无匹配规则</div>
    <div v-else-if="visibleItems.length === 0 && scopeFilter === 'SESSION'" class="empty-state">
      暂无会话级规则，可在审批卡片点击「总是允许」创建
    </div>
    <div v-else-if="visibleItems.length === 0" class="empty-state">
      暂无用户级规则，可在审批卡片点击「总是允许」创建会话级规则，或在此手动添加
    </div>
    <div v-else class="rules-list">
      <template v-for="item in visibleItems" :key="item.id">
        <!-- 会话级规则卡片：来自会话可点击跳转，支持提升 / 删除（无编辑与启停） -->
        <div v-if="item.scope === 'SESSION'" class="rule-card">
          <div class="rule-main">
            <span class="rule-type-badge" :class="`type-${item.ruleType.toLowerCase()}`">{{ typeLabel(item.ruleType) }}</span>
            <code class="rule-value">{{ item.ruleValue }}</code>
            <span class="session-badge">会话级</span>
          </div>
          <div class="rule-meta">
            <span class="meta-item">来自会话：<a class="session-link" title="跳回该会话" @click="openSession(item.sessionId)">{{ item.sessionTitle || `#${item.sessionId}` }}</a></span>
            <span class="meta-item">放行 {{ item.hitCount }} 次</span>
            <span class="meta-item">最近命中 {{ formatTime(item.lastHitAt) }}</span>
            <div class="rule-actions">
              <template v-if="deletingId === item.id">
                <button class="action-text action-text-danger" @click="confirmDelete(item)">确认删除</button>
                <button class="action-text" @click="deletingId = null">取消</button>
              </template>
              <template v-else>
                <button class="action-text" :disabled="promotingId === item.id" @click="promote(item)">
                  {{ promotingId === item.id ? '提升中…' : '提升为用户级' }}
                </button>
                <button class="action-text action-text-danger" @click="deletingId = item.id">删除</button>
              </template>
            </div>
          </div>
        </div>
        <!-- 用户级规则卡片 -->
        <div v-else class="rule-card" :class="{ disabled: !item.enabled }">
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
      </template>
    </div>

    <el-pagination
      v-if="!searching && total > pageSize"
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
import { ref, computed, watch, onMounted } from 'vue'
import { Plus, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import {
  listApprovalRules,
  createApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
  promoteApprovalRule,
  getSession,
  type ApprovalRule,
  type ApprovalRuleScope,
  type ApprovalRuleType
} from '../../api'
import { previewRuleValue } from '../../utils/approvalRulePreview'

const router = useRouter()

const loading = ref(false)
const items = ref<ApprovalRule[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

/** 顶层级别 Tab：USER（跨会话）/ SESSION（本会话 always-allow 落的规则）。 */
const scopeFilter = ref<ApprovalRuleScope>('USER')
/** 关键词：纯前端过滤（非空时单次拉取前 100 条再按 ruleValue 包含匹配）。 */
const keyword = ref('')
const promotingId = ref<number | null>(null)

const typeFilter = ref<ApprovalRuleType | ''>('')

const TYPE_LABELS: Record<ApprovalRuleType, string> = {
  SHELL_PREFIX: '命令前缀',
  SHELL_EXACT: '完整命令',
  MCP_TOOL: 'MCP 工具'
}

const typeTabs: Array<{ value: ApprovalRuleType | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'SHELL_PREFIX', label: TYPE_LABELS.SHELL_PREFIX },
  { value: 'SHELL_EXACT', label: TYPE_LABELS.SHELL_EXACT },
  { value: 'MCP_TOOL', label: TYPE_LABELS.MCP_TOOL }
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

const normalizedPreview = computed(() => previewRuleValue(form.value.ruleType, form.value.ruleValue))

const canSubmit = computed(() => form.value.ruleValue.trim().length > 0 && normalizedPreview.value !== '')

/** 卡片徽标用短标签（与筛选 tab 的完整称谓刻意不同：徽标空间窄）。 */
const TYPE_BADGE_LABELS: Record<ApprovalRuleType, string> = {
  SHELL_PREFIX: '前缀',
  SHELL_EXACT: '全等',
  MCP_TOOL: 'MCP'
}

function typeLabel(t: ApprovalRuleType): string {
  return TYPE_BADGE_LABELS[t] ?? t
}

function formatTime(value?: string | null) {
  if (!value) return '—'
  return String(value).replace('T', ' ').slice(0, 16)
}

const searchKeyword = computed(() => keyword.value.trim().toLowerCase())
/** 搜索态：非空时按前 100 条拉取 + 前端包含匹配（规则量级小；超过 100 条用类型 Tab 收窄）。 */
const searching = computed(() => searchKeyword.value !== '')
const visibleItems = computed(() => {
  if (!searching.value) return items.value
  return items.value.filter((item) => item.ruleValue.toLowerCase().includes(searchKeyword.value))
})

async function fetchList() {
  loading.value = true
  try {
    // 类型 Tab 走服务端过滤：分页/total/空态都以当前类型为准，不受「只看了当前一页」影响；
    // 搜索态一次拉取前 100 条（后端 pageSize 上限），交给 visibleItems 前端过滤并隐藏分页
    const result = await listApprovalRules({
      page: searching.value ? 1 : page.value,
      pageSize: searching.value ? 100 : pageSize.value,
      scope: scopeFilter.value,
      ruleType: typeFilter.value === '' ? null : typeFilter.value
    })
    items.value = result.records ?? []
    total.value = result.total ?? 0
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    loading.value = false
  }
}

// 进入 / 退出搜索态时切换拉取策略（页码恢复第 1 页）；搜索中输入只触发前端过滤，不重复请求
let lastSearchActive = false
watch(keyword, (value) => {
  const active = value.trim() !== ''
  if (active === lastSearchActive) return
  lastSearchActive = active
  page.value = 1
  void fetchList()
})

function reload() {
  page.value = 1
  void fetchList()
}

function changeScope(value: ApprovalRuleScope) {
  if (scopeFilter.value === value) return
  scopeFilter.value = value
  page.value = 1
  deletingId.value = null
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
      // 重复值提示去重（表无唯一键，服务端允许同值多行）；跨页拉取同类型规则，不受当前 tab/页码影响
      const raw = normalizedPreview.value
      const existing = await listApprovalRules({ page: 1, pageSize: 100, ruleType: form.value.ruleType })
      if ((existing.records ?? []).some(r => r.ruleValue === raw)) {
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

/** 会话级规则提升为用户级（复制语义：原会话级规则保留，同值幂等）。 */
async function promote(item: ApprovalRule) {
  if (promotingId.value != null) return
  promotingId.value = item.id
  try {
    await promoteApprovalRule(item.id)
    ElMessage.success('已提升为用户级规则')
  } catch {
    // 错误提示由拦截器统一处理（denylist 拒绝等）
  } finally {
    promotingId.value = null
  }
}

/** 来源会话跳转：先探测存在（已删/非本人 toast），再跳回会话。 */
async function openSession(sessionId: number | null) {
  if (sessionId == null) return
  try {
    await getSession(sessionId)
    void router.push(`/tasks/${sessionId}`)
  } catch {
    ElMessage.warning('来源会话已删除')
  }
}

async function confirmDelete(item: ApprovalRule) {
  try {
    await deleteApprovalRule(item.id)
    ElMessage.success(item.scope === 'SESSION' ? '已删除，该命令将恢复审批' : '已删除')
    deletingId.value = null
    if (!searching.value && items.value.length === 1 && page.value > 1) {
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

.scope-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}

.scope-tab {
  padding: 5px 14px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.scope-tab:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.scope-tab.active {
  color: var(--aw-primary);
  border-color: var(--aw-primary);
  background: var(--aw-accent-bg);
  font-weight: 500;
}

.rules-search {
  flex: 1;
  max-width: 240px;
}

.session-badge {
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

.session-link {
  color: var(--aw-primary);
  cursor: pointer;
  text-decoration: none;
}

.session-link:hover {
  text-decoration: underline;
}

.action-text:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
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
