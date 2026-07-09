<template>
  <!-- 历史轮次：始终折叠 -->
  <template v-for="round in historyRounds" :key="round.userMessage.id">
    <MessageBubble
      :message="round.userMessage"
      :show-time="true"
      :can-edit="canEditMessage?.(round.userMessage) ?? false"
      :is-editing="editingMessageId === round.userMessage.id"
      @edit="$emit('edit', round.userMessage)"
      @cancel-edit="$emit('cancelEdit')"
      @confirm-edit="$emit('confirmEdit', round.userMessage.id, $event)"
      @add-to-command="$emit('addToCommand', $event)"
    />

    <template v-if="round.collapsedSteps.length > 0">
      <div v-if="round.finalReply" class="final-reply-time">
        {{ formatDateTime(round.finalReply.createdAt) }}
      </div>

      <div class="execution-steps-collapse">
        <div class="steps-summary" @click="toggleRound(round.userMessage.id)">
          <el-icon class="steps-expand-icon" :class="{ expanded: roundsExpanded[round.userMessage.id] }"><ArrowDown /></el-icon>
          <span>已执行 {{ round.stepCount }} 个步骤，任务耗时 {{ round.durationText }}</span>
        </div>
        <div v-if="roundsExpanded[round.userMessage.id]" class="steps-detail">
          <MessageBubble
            v-for="step in round.collapsedSteps"
            :key="step.id"
            :message="step"
            :show-time="false"
            :show-copy="false"
            :hide-file-changes="true"
          />
        </div>
      </div>

      <MessageBubble
        v-if="round.finalReply"
        :message="round.finalReply"
        :hide-thinking="true"
        :hide-file-changes="true"
      />

      <FileChangePanel
        v-if="round.fileChanges.length > 0"
        :changes="round.fileChanges"
        mode="history"
      />
    </template>

    <MessageBubble
      v-else-if="round.finalReply"
      :message="round.finalReply"
      :show-time="true"
      :hide-file-changes="true"
    />
    <FileChangePanel
      v-if="!round.collapsedSteps.length && round.fileChanges.length > 0"
      :changes="round.fileChanges"
      mode="history"
    />
  </template>

  <!-- 当前轮次：执行中平铺展示 -->
  <template v-if="activeRound">
    <MessageBubble
      :message="activeRound.userMessage"
      :show-time="true"
      :can-edit="canEditMessage?.(activeRound.userMessage) ?? false"
      :is-editing="editingMessageId === activeRound.userMessage.id"
      @edit="$emit('edit', activeRound.userMessage)"
      @cancel-edit="$emit('cancelEdit')"
      @confirm-edit="$emit('confirmEdit', activeRound.userMessage.id, $event)"
      @add-to-command="$emit('addToCommand', $event)"
    />
    <MessageBubble
      v-for="msg in activeRoundMsgs"
      :key="msg.id"
      :message="msg"
      :show-time="false"
      :show-copy="false"
      :is-last="msg === activeRoundMsgs[activeRoundMsgs.length - 1]"
    />
    <FileChangePanel
      v-if="activeRound.fileChanges.length > 0"
      :changes="activeRound.fileChanges"
      mode="history"
    />
  </template>

  <!-- 无轮次时：直接渲染所有消息 -->
  <template v-if="historyRounds.length === 0 && !activeRound">
    <MessageBubble
      v-for="(msg, idx) in messages"
      :key="msg.id"
      :message="msg"
      :show-time="msg.role === 'user' || (msg.role === 'assistant' && idx < messages.length - 1)"
      :show-copy="false"
      :is-last="idx === messages.length - 1"
      :can-edit="canEditMessage?.(msg) ?? false"
      :is-editing="editingMessageId === msg.id"
      @edit="$emit('edit', msg)"
      @cancel-edit="$emit('cancelEdit')"
      @confirm-edit="$emit('confirmEdit', msg.id, $event)"
      @add-to-command="$emit('addToCommand', $event)"
    />
  </template>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import type { ChatMessage } from '../../types/chat'
import { useMessageRounds } from '../../composables/useMessageRounds'
import { formatDateTime } from '../../utils/datetime'
import MessageBubble from './MessageBubble.vue'
import FileChangePanel from './FileChangePanel.vue'

const props = defineProps<{
  messages: ChatMessage[]
  sending: boolean
  editingMessageId?: string | null
  canEditMessage?: (msg: ChatMessage) => boolean
}>()

defineEmits<{
  edit: [msg: ChatMessage]
  cancelEdit: []
  confirmEdit: [messageId: string, content: string]
  addToCommand: [content: string]
}>()

const messagesRef = toRef(props, 'messages')
const sendingRef = toRef(props, 'sending')

const {
  roundsExpanded,
  historyRounds,
  activeRound,
  activeRoundMsgs,
  toggleRound,
} = useMessageRounds(messagesRef, sendingRef)
</script>

<style scoped>
.final-reply-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
  margin-bottom: 4px;
}

.execution-steps-collapse {
  margin-bottom: 5px;
}

.execution-steps-collapse .steps-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, color 0.15s;
}

.execution-steps-collapse .steps-summary:hover {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
}

.execution-steps-collapse .steps-expand-icon {
  font-size: 12px;
  transition: transform 0.2s;
}

.execution-steps-collapse .steps-expand-icon.expanded {
  transform: rotate(180deg);
}

.execution-steps-collapse .steps-detail {
  margin-top: 8px;
}
</style>
