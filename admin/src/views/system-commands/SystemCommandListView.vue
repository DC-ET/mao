<template>
  <div class="system-commands">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">系统指令</div>
            <div class="card-hint">管理所有用户可见的全局快捷指令。</div>
          </div>
          <el-button type="primary" @click="openCreate">新增指令</el-button>
        </div>
      </template>

      <el-table v-if="!isMobile" :data="commands" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无系统指令" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="指令名称" width="160" />
        <el-table-column label="指令内容" min-width="300" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="content-preview">{{ row.content }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm
              :title="`确认删除指令「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in commands" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
          </div>
          <div class="mobile-card-content">{{ row.content }}</div>
          <div class="mobile-card-actions">
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm
              :title="`确认删除指令「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </el-card>
        <el-empty v-if="!loading && commands.length === 0" description="暂无系统指令" />
      </div>
    </el-card>

    <ResponsiveDialog
      v-if="formVisible"
      v-model="formVisible"
      :title="isEdit ? '编辑指令' : '新增指令'"
      width="560px"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px">
        <el-form-item label="指令名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="字母、数字、中文、下划线、连字符"
            :disabled="false"
          />
          <div class="form-hint">同一范围内名称需唯一，支持字母、数字、中文、下划线和连字符。</div>
        </el-form-item>
        <el-form-item label="指令内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            placeholder="指令内容（提示词模板）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { onActivated, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

const { isMobile } = useBreakpoint()

interface SystemCommandVO {
  id?: number
  name?: string
  content?: string
}

const loading = ref(false)
const commands = ref<SystemCommandVO[]>([])

const formVisible = ref(false)
const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const editingId = ref<number | null>(null)

const form = reactive({
  name: '',
  content: '',
})

const NAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/

const formRules: FormRules = {
  name: [
    { required: true, message: '请输入指令名称', trigger: 'blur' },
    {
      pattern: NAME_PATTERN,
      message: '名称只能包含字母、数字、中文、下划线和连字符',
      trigger: 'blur',
    },
  ],
  content: [{ required: true, message: '请输入指令内容', trigger: 'blur' }],
}

async function loadData() {
  loading.value = true
  try {
    const { data } = await api.get('/admin/system-commands')
    commands.value = data || []
  } catch {
    // interceptor handles toast
  } finally {
    loading.value = false
  }
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  form.name = ''
  form.content = ''
  formVisible.value = true
}

function openEdit(row: SystemCommandVO) {
  isEdit.value = true
  editingId.value = row.id ?? null
  form.name = row.name || ''
  form.content = row.content || ''
  formVisible.value = true
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload = {
    name: form.name.trim(),
    content: form.content,
  }

  submitting.value = true
  try {
    if (isEdit.value && editingId.value != null) {
      await api.put(`/admin/system-commands/${editingId.value}`, payload)
      ElMessage.success('指令更新成功')
    } else {
      await api.post('/admin/system-commands', payload)
      ElMessage.success('指令创建成功')
    }
    formVisible.value = false
    await loadData()
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: SystemCommandVO) {
  try {
    await api.delete(`/admin/system-commands/${row.id}`)
    ElMessage.success('删除成功')
    await loadData()
  } catch {
    // interceptor handles toast
  }
}

onActivated(loadData)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.card-hint {
  margin-top: 4px;
  font-size: 13px;
  color: var(--mao-muted);
}

.content-preview {
  font-size: 13px;
  color: var(--mao-ink);
  white-space: pre-wrap;
}

.form-hint {
  color: var(--mao-muted);
  font-size: 12px;
  margin-top: 4px;
}

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mobile-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mobile-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.mobile-card-content {
  font-size: 13px;
  color: var(--mao-ink);
  white-space: pre-wrap;
  margin-bottom: 8px;
}

.mobile-card-actions {
  display: flex;
  gap: 8px;
}
</style>