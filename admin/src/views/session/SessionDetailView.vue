<template>
  <div class="session-detail" v-loading="loading">
    <!-- Header -->
    <el-page-header @back="router.push('/sessions')" :title="'返回列表'">
      <template #content>
        <span class="page-title">{{ sessionInfo?.title || '会话详情' }}</span>
      </template>
    </el-page-header>

    <!-- Session info -->
    <el-card v-if="sessionInfo" class="info-card">
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="ID">{{ sessionInfo.id }}</el-descriptions-item>
        <el-descriptions-item label="用户">{{ sessionInfo.userName }}</el-descriptions-item>
        <el-descriptions-item label="Agent">{{ sessionInfo.agentName }}</el-descriptions-item>
        <el-descriptions-item label="模型">{{ sessionInfo.modelName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="执行模式">
          <el-tag :type="sessionInfo.executionMode === 'CLOUD' ? 'primary' : 'warning'" size="small">
            {{ sessionInfo.executionMode }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="任务阶段">
          <el-tag :type="phaseTagType(sessionInfo.phase)" size="small">{{ sessionInfo.phase }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="项目">{{ sessionInfo.projectKey || '-' }}</el-descriptions-item>
        <el-descriptions-item label="上下文Token">{{ sessionInfo.contextTokens || '-' }}</el-descriptions-item>
        <el-descriptions-item label="摘要" :span="2">{{ sessionInfo.summary || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ sessionInfo.createdAt }}</el-descriptions-item>
        <el-descriptions-item label="最后活动">{{ sessionInfo.lastActivityAt || sessionInfo.updatedAt }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- Chat messages -->
    <el-card class="chat-card">
      <template #header>
        <span class="card-header">聊天记录 ({{ messageTurns.length }} 轮对话)</span>
      </template>

      <div v-if="messages.length === 0 && !loading" class="empty-state">
        <el-empty description="暂无消息" />
      </div>

      <div v-else class="chat-container">
        <MessageGroup
          v-for="turn in messageTurns"
          :key="turn.user.id"
          :user-message="turn.user"
          :assistant-messages="turn.assistants"
          :workspace="sessionInfo?.workspace"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api'
import { mapApiMessagesToChat } from './utils/chatMessage'
import type { ChatMessage } from './types/chat'
import MessageGroup from './components/MessageGroup.vue'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const sessionInfo = ref<any>(null)
const messages = ref<ChatMessage[]>([])

interface MessageTurn {
  user: ChatMessage
  assistants: ChatMessage[]
}

const messageTurns = computed((): MessageTurn[] => {
  const turns: MessageTurn[] = []
  let currentTurn: MessageTurn | null = null

  for (const msg of messages.value) {
    if (msg.role === 'user') {
      currentTurn = { user: msg, assistants: [] }
      turns.push(currentTurn)
    } else if (msg.role === 'assistant' && currentTurn) {
      currentTurn.assistants.push(msg)
    }
  }

  return turns
})

function phaseTagType(phase: string): '' | 'success' | 'danger' | 'warning' | 'info' {
  switch (phase) {
    case 'RUNNING': return ''
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

async function fetchDetail() {
  const id = route.params.id
  loading.value = true
  try {
    const [sessionRes, messagesRes] = await Promise.all([
      api.get(`/admin/sessions/${id}`),
      api.get(`/admin/sessions/${id}/messages`)
    ])
    sessionInfo.value = sessionRes.data
    const rawMessages = messagesRes.data?.messages || []
    messages.value = mapApiMessagesToChat(rawMessages)
  } finally {
    loading.value = false
  }
}

onMounted(fetchDetail)
</script>

<style scoped>
.session-detail {
  width: 100%;
}

.page-title {
  font-size: 16px;
  font-weight: 600;
}

.info-card {
  margin-top: 16px;
}

.chat-card {
  margin-top: 16px;
}

.card-header {
  font-size: 16px;
  font-weight: 600;
}

.chat-container {
  max-height: calc(100vh - 360px);
  overflow-y: auto;
  padding: 0 4px;
}

.empty-state {
  padding: 40px 0;
}
</style>
