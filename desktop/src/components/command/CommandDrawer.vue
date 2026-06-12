<template>
  <el-drawer
    v-model="visible"
    title="我的指令"
    direction="rtl"
    size="420px"
    :before-close="handleClose"
  >
    <div class="command-drawer-body">
      <p class="command-subtitle">创建和管理个人快捷指令。</p>

      <button class="create-btn" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>
        新建指令
      </button>

      <!-- Command list -->
      <div class="command-list">
        <div v-if="loading" class="command-empty">加载中...</div>
        <div v-else-if="commands.length === 0" class="command-empty">暂无个人指令</div>
        <div v-else class="command-cards">
          <div v-for="cmd in commands" :key="cmd.id" class="command-card">
            <div class="command-card-header">
              <div class="command-name">{{ cmd.name }}</div>
              <div class="command-actions">
                <el-tooltip content="编辑" :show-after="300" placement="top">
                  <button class="cmd-btn" @click="openEditDialog(cmd)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </el-tooltip>
                <el-tooltip content="删除" :show-after="300" placement="top">
                  <button class="cmd-btn cmd-btn-danger" @click="handleDelete(cmd)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </el-tooltip>
              </div>
            </div>
            <el-tooltip :content="cmd.content" placement="bottom" :show-after="300" popper-class="command-preview-tip">
              <div class="command-preview">{{ cmd.content }}</div>
            </el-tooltip>
          </div>
        </div>
      </div>
    </div>

    <!-- Create/Edit dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑指令' : '新建指令'"
      width="480px"
      class="command-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <el-form-item label="指令名称" :error="nameError">
          <el-input
            v-model="form.name"
            placeholder="仅支持字母、数字、中文、下划线和连字符"
            maxlength="100"
            @input="validateName"
          />
        </el-form-item>
        <el-form-item label="指令内容">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            placeholder="请输入提示词模板内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit" @click="handleSubmit">
          {{ isEditing ? '保存' : '创建' }}
        </button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useCommandDrawer } from '../../composables/useCommandDrawer'

interface CommandItem {
  id: number
  name: string
  content: string
}

const { visible, prefillContent, clearPrefill } = useCommandDrawer()

// When opened with prefill content (from chat message "add to command"), auto-open create dialog
watch(prefillContent, (content) => {
  if (content) {
    isEditing.value = false
    editingId.value = null
    form.value = { name: '', content }
    nameError.value = ''
    dialogVisible.value = true
    clearPrefill()
  }
})

const loading = ref(false)
const commands = ref<CommandItem[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const form = ref({ name: '', content: '' })
const nameError = ref('')

const namePattern = /^[a-zA-Z0-9一-龥_-]+$/

const canSubmit = computed(() =>
  form.value.name.trim().length > 0 &&
  form.value.content.trim().length > 0 &&
  namePattern.test(form.value.name)
)

function validateName() {
  const name = form.value.name
  if (name.length === 0) {
    nameError.value = ''
  } else if (!namePattern.test(name)) {
    nameError.value = '名称只能包含字母、数字、中文、下划线和连字符'
  } else {
    nameError.value = ''
  }
}

watch(visible, (val) => {
  if (val) fetchCommands()
})

async function fetchCommands() {
  loading.value = true
  try {
    const { data } = await api.get('/user-commands')
    commands.value = data || []
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { name: '', content: '' }
  nameError.value = ''
  dialogVisible.value = true
}

function openEditDialog(cmd: CommandItem) {
  isEditing.value = true
  editingId.value = cmd.id
  form.value = { name: cmd.name, content: cmd.content }
  nameError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  form.value = { name: '', content: '' }
  isEditing.value = false
  editingId.value = null
  nameError.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value) return

  try {
    if (isEditing.value) {
      await api.put(`/user-commands/${editingId.value}`, {
        name: form.value.name.trim(),
        content: form.value.content
      })
      ElMessage.success('指令已更新')
    } else {
      await api.post('/user-commands', {
        name: form.value.name.trim(),
        content: form.value.content
      })
      ElMessage.success('指令已创建')
    }
    dialogVisible.value = false
    await fetchCommands()
  } catch {
    // Error handled by interceptor
  }
}

async function handleDelete(cmd: CommandItem) {
  try {
    await ElMessageBox.confirm(
      `确认删除指令「${cmd.name}」？`,
      '确认',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
    await api.delete(`/user-commands/${cmd.id}`)
    ElMessage.success(`指令「${cmd.name}」已删除`)
    await fetchCommands()
  } catch {
    // Cancelled or error
  }
}

function handleClose(done: () => void) {
  done()
}
</script>

<style scoped>
.command-drawer-body {
  padding: 0 4px;
}

.command-subtitle {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0 0 16px 0;
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
  transition: opacity 0.15s;
  margin-bottom: 16px;
}

.create-btn:hover {
  opacity: 0.85;
}

.command-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.command-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.command-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 10px 14px;
  transition: border-color 0.15s;
}

.command-card:hover {
  border-color: var(--aw-divider);
}

.command-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.command-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.command-actions {
  display: flex;
  gap: 2px;
}

.cmd-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted);
  transition: color 0.15s, background 0.15s;
}

.cmd-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.cmd-btn-danger:hover {
  color: var(--aw-danger);
}

.command-preview {
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-cancel:hover {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:hover:not(:disabled) {
  opacity: 0.85;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<style>
.command-dialog {
  --el-font-size-base: 14px;
  --el-font-size-small: 13px;
  --el-font-size-extra-small: 12px;
}

.command-preview-tip {
  max-width: 360px;
  word-break: break-word;
}
</style>
