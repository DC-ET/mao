<template>
  <section id="setting-group-git-default-credentials" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">Git 默认凭证</span>
          <el-button type="primary" size="small" :disabled="!canWrite" @click="openCreateDialog">新增默认凭证</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="按域名托管系统默认 Git Token：用户未配置该域时自动兜底注入，同域用户凭证优先。建议配置只读 Token；凭据经 Agent「允许域」白名单约束后才会注入。"
        class="config-tip"
      />
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="加密项保存后仅显示掩码，留空表示不修改。"
        class="config-tip"
      />

      <el-table v-loading="loading" :data="items" stripe>
        <el-table-column label="域名" prop="domain" min-width="200" show-overflow-tooltip />
        <el-table-column label="Token" width="110">
          <template #default="{ row }">{{ row.accessToken }}</template>
        </el-table-column>
        <el-table-column label="备注" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.description || '-' }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="!canWrite" @click="openEditDialog(row)">编辑</el-button>
            <template v-if="deletingId === row.id">
              <el-button link type="danger" :disabled="!canWrite" @click="confirmDelete(row)">确认删除</el-button>
              <el-button link @click="deletingId = null">取消</el-button>
            </template>
            <el-button v-else link type="danger" :disabled="!canWrite" @click="deletingId = row.id">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && items.length === 0" description="暂无系统默认凭证；未配置任何默认凭证时，用户凭据行为与现状完全一致" />
    </el-card>

    <el-dialog v-model="dialogVisible" :title="isEditing ? '编辑默认凭证' : '新增默认凭证'" width="520px" @closed="resetForm">
      <el-form label-width="110px" @submit.prevent>
        <el-form-item label="域名" required>
          <el-input
            v-model="form.domain"
            :disabled="isEditing"
            placeholder="如 github.com、git.acg.team"
          />
          <div class="field-hint">{{ isEditing ? '域名不可修改；如需更换请删除后重建。' : '用户未配置该域时自动使用此处的 Token 兜底。' }}</div>
        </el-form-item>
        <el-form-item label="Access Token" required>
          <el-input
            v-model="form.accessToken"
            :type="showToken ? 'text' : 'password'"
            :placeholder="isEditing ? '留空表示不修改 Token' : '粘贴 Personal Access Token（建议只读）'"
          >
            <template #suffix>
              <el-icon
                class="token-toggle"
                :title="showToken ? '隐藏 Token' : '显示 Token'"
                :aria-label="showToken ? '隐藏 Token' : '显示 Token'"
                @click="showToken = !showToken"
              >
                <View v-if="!showToken" />
                <Hide v-else />
              </el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.description" maxlength="512" placeholder="如：只读 Token，写权限请联系 XX" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">{{ isEditing ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { View, Hide } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../api'

interface GitDefaultCredentialItem {
  id: number
  domain: string
  accessToken: string
  description: string | null
  createdAt: string | null
  updatedAt: string | null
}

const props = defineProps<{
  canWrite: boolean
}>()

const loading = ref(false)
const items = ref<GitDefaultCredentialItem[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const showToken = ref(false)
const submitting = ref(false)

const form = ref({ domain: '', accessToken: '', description: '' })

function formatDateTime(value?: string | null) {
  if (!value) return '-'
  return String(value).replace('T', ' ').slice(0, 19)
}

async function fetchList() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/git-default-credentials')
    items.value = (data ?? []) as GitDefaultCredentialItem[]
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { domain: '', accessToken: '', description: '' }
  showToken.value = false
  dialogVisible.value = true
}

function openEditDialog(row: GitDefaultCredentialItem) {
  isEditing.value = true
  editingId.value = row.id
  form.value = { domain: row.domain, accessToken: '', description: row.description ?? '' }
  showToken.value = false
  dialogVisible.value = true
}

function resetForm() {
  form.value = { domain: '', accessToken: '', description: '' }
  isEditing.value = false
  editingId.value = null
}

async function handleSubmit() {
  if (!isEditing.value && form.value.domain.trim() === '') {
    ElMessage.warning('请填写域名')
    return
  }
  if (!isEditing.value && form.value.accessToken.trim() === '') {
    ElMessage.warning('请填写 Access Token')
    return
  }
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await api.put(`/admin/git-default-credentials/${editingId.value}`, {
        accessToken: form.value.accessToken,
        description: form.value.description
      })
      ElMessage.success('已保存')
    } else {
      await api.post('/admin/git-default-credentials', {
        domain: form.value.domain.trim(),
        accessToken: form.value.accessToken,
        description: form.value.description
      })
      ElMessage.success('已创建')
    }
    dialogVisible.value = false
    void fetchList()
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(row: GitDefaultCredentialItem) {
  deletingId.value = null
  await api.delete(`/admin/git-default-credentials/${row.id}`)
  ElMessage.success(`已删除 ${row.domain} 的默认凭证`)
  void fetchList()
}

onMounted(() => {
  void fetchList()
})
</script>

<style scoped>
.config-tip {
  margin-bottom: 8px;
}

.token-toggle {
  cursor: pointer;
}
</style>
