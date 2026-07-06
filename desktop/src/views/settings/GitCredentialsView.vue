<template>
  <div class="git-credentials-page">
    <div class="page-header">
      <h1 class="page-title">Git 凭证</h1>
      <p class="page-desc">
        按 Git 域名配置个人 Access Token，用于云端模式克隆私有仓库及 Shell 中的 git 远程操作。
      </p>
    </div>

    <button class="create-btn" @click="openCreateDialog">
      <el-icon><Plus /></el-icon>
      新增凭证
    </button>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="credentials.length === 0" class="empty-state">
      暂无 Git 凭证，点击上方按钮添加
    </div>
    <div v-else class="credential-list">
      <div v-for="item in credentials" :key="item.id" class="credential-card">
        <div class="credential-header">
          <div class="credential-domain">{{ item.domain }}</div>
          <div class="credential-actions">
            <template v-if="deletingId === item.id">
              <button class="action-btn action-btn-danger" @click="confirmDelete(item)">
                <el-icon :size="14"><Check /></el-icon>
              </button>
              <button class="action-btn" @click="deletingId = null">
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
        <div class="credential-meta">
          <span class="credential-token">Token: {{ item.accessToken }}</span>
          <span v-if="item.description" class="credential-desc">{{ item.description }}</span>
        </div>
        <div class="credential-time">更新于 {{ formatTime(item.updatedAt) }}</div>
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑 Git 凭证' : '新增 Git 凭证'"
      width="480px"
      class="git-credential-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <el-form-item v-if="!isEditing" label="域名" :error="domainError">
          <el-input
            v-model="form.domain"
            placeholder="如 github.com、gitlab.com、git.example.com"
            @input="validateDomain"
          />
        </el-form-item>
        <el-form-item v-else label="域名">
          <el-input :model-value="form.domain" disabled />
        </el-form-item>
        <el-form-item label="Access Token">
          <el-input
            v-model="form.accessToken"
            :type="showToken ? 'text' : 'password'"
            :placeholder="isEditing ? '留空则不修改 Token' : '粘贴 Personal Access Token'"
          >
            <template #suffix>
              <el-icon class="token-toggle" @click="showToken = !showToken">
                <View v-if="!showToken" />
                <Hide v-else />
              </el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="备注（选填）">
          <el-input v-model="form.description" placeholder="如：个人 GitHub Token" />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit" @click="handleSubmit">
          {{ isEditing ? '保存' : '创建' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Check, Close, Edit, Delete, View, Hide } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

interface GitCredentialItem {
  id: number
  domain: string
  accessToken: string
  description?: string
  createdAt?: string
  updatedAt?: string
}

const loading = ref(false)
const credentials = ref<GitCredentialItem[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const showToken = ref(false)
const domainError = ref('')

const form = ref({
  domain: '',
  accessToken: '',
  description: ''
})

const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

const canSubmit = computed(() => {
  if (isEditing.value) {
    return true
  }
  return form.value.domain.trim().length > 0
    && domainPattern.test(normalizeDomain(form.value.domain))
    && form.value.accessToken.trim().length > 0
})

function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase()
  if (d.startsWith('https://')) d = d.slice(8)
  if (d.startsWith('http://')) d = d.slice(7)
  const slash = d.indexOf('/')
  if (slash >= 0) d = d.slice(0, slash)
  return d
}

function validateDomain() {
  const domain = form.value.domain
  if (!domain.trim()) {
    domainError.value = ''
    return
  }
  domainError.value = domainPattern.test(normalizeDomain(domain))
    ? ''
    : '域名格式无效，示例: github.com'
}

function formatTime(value?: string) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

async function fetchCredentials() {
  loading.value = true
  try {
    const { data } = await api.get('/user/git-credentials')
    credentials.value = data || []
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  showToken.value = false
  form.value = { domain: '', accessToken: '', description: '' }
  domainError.value = ''
  dialogVisible.value = true
}

function openEditDialog(item: GitCredentialItem) {
  isEditing.value = true
  editingId.value = item.id
  showToken.value = false
  form.value = {
    domain: item.domain,
    accessToken: '',
    description: item.description || ''
  }
  domainError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  form.value = { domain: '', accessToken: '', description: '' }
  isEditing.value = false
  editingId.value = null
  showToken.value = false
  domainError.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value) return

  try {
    if (isEditing.value && editingId.value != null) {
      const payload: { accessToken?: string; description?: string } = {
        description: form.value.description.trim() || undefined
      }
      if (form.value.accessToken.trim()) {
        payload.accessToken = form.value.accessToken.trim()
      }
      await api.put(`/user/git-credentials/${editingId.value}`, payload)
      ElMessage.success('凭证已更新')
    } else {
      await api.post('/user/git-credentials', {
        domain: normalizeDomain(form.value.domain),
        accessToken: form.value.accessToken.trim(),
        description: form.value.description.trim() || undefined
      })
      ElMessage.success('凭证已创建')
    }
    dialogVisible.value = false
    await fetchCredentials()
  } catch {
    // handled by interceptor
  }
}

async function confirmDelete(item: GitCredentialItem) {
  try {
    await api.delete(`/user/git-credentials/${item.id}`)
    ElMessage.success(`已删除 ${item.domain} 的凭证`)
    deletingId.value = null
    await fetchCredentials()
  } catch {
    // handled by interceptor
  }
}

onMounted(() => {
  fetchCredentials()
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
  line-height: 1.5;
  max-width: 560px;
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

.credential-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 640px;
}

.credential-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 12px 14px;
}

.credential-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.credential-domain {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
}

.credential-actions {
  display: flex;
  gap: 2px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted);
}

.action-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.credential-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.credential-token {
  font-family: var(--aw-font-mono, monospace);
}

.credential-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--aw-ink-muted);
}

.token-toggle {
  cursor: pointer;
  color: var(--aw-ink-muted);
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
</style>

<style>
.git-credential-dialog {
  --el-font-size-base: 13px;
  --el-font-size-small: 12px;
  --el-font-size-extra-small: 11px;
}

.git-credential-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}

.git-credential-dialog .el-dialog__body {
  padding-top: 12px;
}

.git-credential-dialog .el-form-item {
  margin-bottom: 14px;
}

.git-credential-dialog .el-form-item__label {
  font-size: 12px;
  line-height: 1.4;
  margin-bottom: 4px !important;
  color: var(--aw-ink-muted);
}

.git-credential-dialog .el-input__wrapper {
  font-size: 13px;
}

.git-credential-dialog .el-input__inner {
  font-size: 13px;
}

.git-credential-dialog .el-input__inner::placeholder {
  font-size: 12px;
  color: var(--aw-ink-muted);
  opacity: 0.75;
}
</style>
