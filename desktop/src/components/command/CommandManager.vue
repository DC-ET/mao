<template>
  <div class="command-manager">
    <el-tabs v-model="activeTab" class="command-tabs">
      <el-tab-pane label="我的指令" name="personal" />
      <el-tab-pane label="系统指令" name="system" />
    </el-tabs>

    <p class="command-subtitle">
      {{ activeTab === 'personal' ? '创建和管理个人快捷指令。' : '查看系统预置的只读快捷指令。' }}
    </p>

    <button v-if="activeTab === 'personal'" class="create-btn" @click="editDialogRef?.open()">
      <el-icon><Plus /></el-icon>
      新建指令
    </button>

    <div class="command-list">
      <div v-if="loading" class="command-empty">加载中...</div>
      <div v-else-if="displayedCommands.length === 0" class="command-empty">
        {{ activeTab === 'personal' ? '暂无个人指令' : '暂无系统指令' }}
      </div>
      <div v-else class="command-cards">
        <div v-for="cmd in displayedCommands" :key="cmd.id" class="command-card">
          <div class="command-card-header">
            <div class="command-name">{{ cmd.name }}</div>
            <div v-if="activeTab === 'personal'" class="command-actions">
              <template v-if="deletingId === cmd.id">
                <button class="cmd-btn cmd-btn-confirm-delete" @click="confirmDelete(cmd)">
                  <el-icon :size="14"><Check /></el-icon>
                </button>
                <button class="cmd-btn" @click="deletingId = null">
                  <el-icon :size="14"><Close /></el-icon>
                </button>
              </template>
              <template v-else>
                <el-tooltip content="编辑" :show-after="300" placement="top">
                  <button class="cmd-btn" @click="editDialogRef?.openEdit(cmd)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </el-tooltip>
                <el-tooltip content="删除" :show-after="300" placement="top">
                  <button class="cmd-btn cmd-btn-danger" @click="deletingId = cmd.id">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </el-tooltip>
              </template>
            </div>
          </div>
          <el-tooltip :content="cmd.content" placement="bottom" :show-after="300" popper-class="command-preview-tip">
            <div class="command-preview">{{ cmd.content }}</div>
          </el-tooltip>
        </div>
      </div>
    </div>

    <CommandEditDialog ref="editDialogRef" @saved="fetchCommands" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Plus, Check, Close } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import CommandEditDialog from './CommandEditDialog.vue'
import { invalidateCommandContent } from '../../utils/commandContent'

interface CommandItem {
  id: number
  name: string
  content: string
}

const editDialogRef = ref<InstanceType<typeof CommandEditDialog>>()

const loading = ref(false)
const activeTab = ref<'personal' | 'system'>('personal')
const commands = ref<CommandItem[]>([])
const systemCommands = ref<CommandItem[]>([])
const displayedCommands = computed(() => activeTab.value === 'personal' ? commands.value : systemCommands.value)
const deletingId = ref<number | null>(null)

watch(activeTab, () => {
  deletingId.value = null
})

onMounted(() => {
  fetchCommands()
})

async function fetchCommands() {
  loading.value = true
  try {
    const [personalResponse, systemResponse] = await Promise.all([
      api.get('/user-commands'),
      api.get('/user-commands/system')
    ])
    commands.value = personalResponse.data || []
    systemCommands.value = systemResponse.data || []
  } catch {
    // 拦截器已统一 toast，避免 unhandledrejection
  } finally {
    loading.value = false
  }
}

async function confirmDelete(cmd: CommandItem) {
  try {
    await api.delete(`/user-commands/${cmd.id}`)
    ElMessage.success(`指令「${cmd.name}」已删除`)
    deletingId.value = null
    invalidateCommandContent()
    await fetchCommands()
  } catch {
    // Error handled by interceptor
  }
}
</script>

<style scoped>
.command-manager {
  padding: 0 4px;
}

.command-tabs {
  margin-bottom: 12px;
}

.command-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.command-tabs :deep(.el-tabs__item) {
  font-size: 14px;
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
  gap: 5px;
}

.command-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 5px 10px;
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

.cmd-btn-confirm-delete {
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
</style>

<style>
.command-preview-tip {
  max-width: 360px;
  word-break: break-word;
}
</style>
