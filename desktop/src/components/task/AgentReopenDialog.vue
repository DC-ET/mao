<template>
  <el-dialog
    v-model="visible"
    title="用其他 Agent 重开"
    width="440px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="reopen-body">
      <p class="reopen-warning">
        将新建一个绑定<b>同一工作区</b>的会话，并由接手说明承接背景；当前会话会<b>归档</b>，
        其文件浏览与 Git 面板可从归档列表回看，聊天记录不会复制到新会话。
      </p>
      <el-select
        v-model="selectedAgentId"
        filterable
        placeholder="选择接手的 Agent"
        class="reopen-select"
      >
        <el-option
          v-for="agent in candidateAgents"
          :key="agent.id"
          :label="agent.name"
          :value="String(agent.id)"
        />
      </el-select>
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!selectedAgentId"
        :loading="submitting"
        @click="handleConfirm"
      >重开</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAgentStore } from '../../stores/agent'
import { reopenSessionWithAgent } from '../../api'

const emit = defineEmits<{
  /** API 成功后触发：TaskView 负责预填接手说明、刷新列表并跳转新会话 */
  reopened: [payload: { sessionId: number; handoverNote: string | null }]
}>()

const agentStore = useAgentStore()
const visible = ref(false)
const submitting = ref(false)
const sessionId = ref<string>('')
const currentAgentId = ref<string | null>(null)
const selectedAgentId = ref<string | null>(null)

const candidateAgents = computed(() =>
  agentStore.agents.filter(a =>
    currentAgentId.value == null || String(a.id) !== String(currentAgentId.value)
  )
)

onMounted(async () => {
  if (agentStore.agents.length === 0 && !agentStore.loading) {
    await agentStore.fetchAgents()
  }
})

function open(id: string, agentId: string | null) {
  sessionId.value = id
  currentAgentId.value = agentId
  selectedAgentId.value = null
  visible.value = true
}

async function handleConfirm() {
  if (!selectedAgentId.value || submitting.value) return
  submitting.value = true
  try {
    const payload = await reopenSessionWithAgent(sessionId.value, Number(selectedAgentId.value))
    visible.value = false
    emit('reopened', payload)
  } catch {
    // 错误 toast 已由 axios 拦截器统一弹出；弹层保持打开供重试
  } finally {
    submitting.value = false
  }
}

defineExpose({ open })
</script>

<style scoped>
.reopen-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reopen-warning {
  margin: 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  line-height: 1.6;
}

.reopen-select {
  width: 100%;
}
</style>
