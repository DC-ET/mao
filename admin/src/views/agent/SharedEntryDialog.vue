<template>
  <el-dialog
    :model-value="true"
    :title="existing ? '编辑团队共享推荐语' : '上架到团队共享'"
    width="560px"
    :close-on-click-modal="false"
    @update:model-value="emit('close')"
  >
    <el-form label-width="88px" :disabled="saving">
      <el-form-item label="Agent">
        <span>{{ agent.name }}</span>
      </el-form-item>
      <el-form-item label="推荐语">
        <el-input
          v-model="note"
          type="textarea"
          :rows="3"
          maxlength="512"
          show-word-limit
          placeholder="适合什么任务、怎么用（对工作台全员可见）"
        />
      </el-form-item>
      <el-form-item label="排序">
        <el-input-number v-model="sortOrder" :min="0" :max="9999" controls-position="right" />
        <span class="sort-tip">数字越小越靠前</span>
      </el-form-item>
    </el-form>
    <el-alert
      v-if="agent.enabled === false"
      type="info"
      :closable="false"
      class="disabled-alert"
      title="该 Agent 已停用：工作台团队共享分区不再展示此条目。停用状态下不能上架或更新推荐语，如需彻底移除请直接下架。"
    />
    <template #footer>
      <div class="dialog-footer">
        <el-button
          v-if="existing || agent.enabled === false"
          type="danger"
          plain
          :loading="saving"
          @click="handleRemove"
        >下架</el-button>
        <div class="footer-right">
          <el-button @click="emit('close')">取消</el-button>
          <el-tooltip
            :disabled="agent.enabled !== false"
            content="请先启用该 Agent"
            placement="top"
          >
            <span>
              <el-button
                type="primary"
                :disabled="agent.enabled === false"
                :loading="saving"
                @click="handleSave"
              >保存</el-button>
            </span>
          </el-tooltip>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

const props = defineProps<{
  agent: { id: number; name: string; enabled?: boolean }
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

interface SharedAgentItem {
  agentId: number
  note: string
  sortOrder: number
}

const note = ref('')
const sortOrder = ref(0)
const existing = ref(false)
const saving = ref(false)

onMounted(async () => {
  saving.value = true
  try {
    const { data } = await api.get<SharedAgentItem[]>('/shared-agents')
    const entry = (data ?? []).find((item) => item.agentId === props.agent.id)
    if (entry) {
      existing.value = true
      note.value = entry.note
      sortOrder.value = entry.sortOrder
    }
  } catch {
    // 拦截器已提示；保持未上架表单
  } finally {
    saving.value = false
  }
})

async function handleSave() {
  if (saving.value) return
  saving.value = true
  try {
    await api.put(`/agents/${props.agent.id}/shared-entry`, {
      note: note.value,
      sortOrder: sortOrder.value,
    })
    ElMessage.success(existing.value ? '推荐语已更新' : '已上架到团队共享')
    emit('saved')
    emit('close')
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false
  }
}

async function handleRemove() {
  try {
    await ElMessageBox.confirm(
      `确定要将 Agent「${props.agent.name}」从团队共享目录下架吗？工作台将不再展示该条目。`,
      '确认下架',
      { type: 'warning' }
    )
  } catch {
    return
  }
  saving.value = true
  try {
    await api.delete(`/agents/${props.agent.id}/shared-entry`)
    ElMessage.success('已下架')
    emit('saved')
    emit('close')
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.sort-tip {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.disabled-alert {
  margin-top: 4px;
}
.dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.footer-right {
  display: flex;
  gap: 10px;
}
</style>
