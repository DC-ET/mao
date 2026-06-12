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
          <div v-for="cmd in commands" :key="cmd.name" class="command-card">
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
            <div class="command-preview">{{ cmd.content.slice(0, 100) }}{{ cmd.content.length > 100 ? '...' : '' }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create/Edit dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑指令' : '新建指令'"
      width="480px"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <el-form-item label="指令名称">
          <el-input
            v-model="form.name"
            :disabled="isEditing"
            placeholder="请输入指令名称"
            maxlength="100"
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
  name: string
  content: string
}

const { visible } = useCommandDrawer()

const loading = ref(false)
const commands = ref<CommandItem[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingName = ref('')
const form = ref({ name: '', content: '' })

const canSubmit = computed(() => form.value.name.trim().length > 0 && form.value.content.trim().length > 0)

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
  editingName.value = ''
  form.value = { name: '', content: '' }
  dialogVisible.value = true
}

function openEditDialog(cmd: CommandItem) {
  isEditing.value = true
  editingName.value = cmd.name
  form.value = { name: cmd.name, content: cmd.content }
  dialogVisible.value = true
}

function resetForm() {
  form.value = { name: '', content: '' }
  isEditing.value = false
  editingName.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value) return

  try {
    if (isEditing.value) {
      await api.put(`/user-commands/${encodeURIComponent(editingName.value)}`, {
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
    await api.delete(`/user-commands/${encodeURIComponent(cmd.name)}`)
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
  white-space: pre-line;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
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
