<template>
  <div class="onboarding-overlay" role="dialog" aria-label="新手引导">
    <div class="wizard-card">
      <header class="wizard-header">
        <h2 class="wizard-title">{{ step === 1 ? '选择一个智能体开始' : step === 2 ? '任务在哪里执行' : '发出你的第一条任务' }}</h2>
        <div class="wizard-steps">
          <span v-for="i in 3" :key="i" class="step-dot" :class="{ active: i === step, done: i < step }" />
        </div>
      </header>

      <!-- 步骤 1：选 Agent -->
      <section v-if="step === 1" class="wizard-body">
        <p class="wizard-hint">智能体决定了助手擅长什么、用哪些工具。之后随时可以在左下角更换。</p>
        <div class="agent-grid">
          <button
            v-for="agent in agents"
            :key="agent.id"
            type="button"
            class="agent-card"
            :class="{ selected: String(agent.id) === String(selectedAgentId) }"
            @click="selectAgent(agent)"
          >
            <el-avatar :size="36" :src="resolveAvatarUrl(agent.avatarUrl)">{{ agent.name?.charAt(0) }}</el-avatar>
            <span class="agent-name">
              {{ agent.name }}
              <el-tag v-if="agent.isDefault" size="small" type="warning" class="default-tag">默认</el-tag>
            </span>
            <span class="agent-desc">{{ agent.description || 'AI Agent' }}</span>
          </button>
        </div>
        <div v-if="agents.length === 0" class="agent-empty">智能体列表加载中，请稍候…</div>
      </section>

      <!-- 步骤 2：执行边界图解 -->
      <section v-else-if="step === 2" class="wizard-body">
        <p class="wizard-hint">同一条任务，可以选择让 Agent 在哪里干活：</p>
        <div class="mode-grid">
          <div class="mode-card">
            <h3>云端执行（推荐）</h3>
            <p>Agent 在服务器的独立工作区里读文件、跑命令，浏览器 / 手机都能用，换电脑不受影响。</p>
          </div>
          <div class="mode-card">
            <h3>本机执行</h3>
            <p>Agent 直接操作你电脑上的目录（需要桌面客户端），高风险操作会先弹窗请你审批。</p>
          </div>
        </div>
        <p class="wizard-hint subtle">不确定就先用云端，第一个任务跑通后再体验本机。</p>
      </section>

      <!-- 步骤 3：第一条任务 -->
      <section v-else class="wizard-body">
        <p class="wizard-hint">已为你准备了一条示例任务（可修改），点「开始任务」即可看到 Agent 调用工具并给出带来源的回答：</p>
        <el-input
          v-model="sampleText"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
          placeholder="想做什么，直接写下来"
        />
        <p class="wizard-hint subtle">如果任务报错也没关系——点消息区的轨迹徽标可以看到 Agent 每一步在做什么。</p>
      </section>

      <footer class="wizard-footer">
        <el-button v-if="step > 1" text @click="step -= 1">上一步</el-button>
        <span class="footer-spacer" />
        <el-button text class="skip-btn" @click="emit('skip')">跳过引导</el-button>
        <el-button v-if="step < 3" type="primary" :disabled="step === 1 && !selectedAgent" @click="next">
          {{ step === 1 ? '下一步' : '下一步' }}
        </el-button>
        <el-button v-else type="primary" :disabled="!sampleText.trim()" @click="finish">开始任务</el-button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../../api'
import { resolveAvatarUrl } from '../../utils/avatar'
import type { Agent } from '../../stores/agent'
import type { SuggestedQuestionVO } from '@mao/contracts'

const props = defineProps<{
  agents: Agent[]
}>()

const emit = defineEmits<{
  complete: [{ chosenAgentId: string | null; sampleText: string }]
  skip: []
}>()

const DEFAULT_SAMPLE_PROMPT = '搜一下本周 AI 领域的重要新闻，给我 5 条带来源的摘要'

const step = ref(1)
const selectedAgentId = ref<string | null>(null)
const suggestedQuestions = ref<string[]>([])
const sampleText = ref('')

const selectedAgent = () => props.agents.find((agent) => String(agent.id) === String(selectedAgentId.value)) ?? null

function selectAgent(agent: Agent) {
  selectedAgentId.value = String(agent.id)
  // 拉详情取推荐问题（列表 VO 不含），失败不阻塞——回退内置示例
  api.get(`/agents/${agent.id}`)
    .then(({ data }) => {
      const questions = ((data?.suggestedQuestions ?? []) as SuggestedQuestionVO[])
        .map((item) => (item.content ?? '').trim())
        .filter(Boolean)
      suggestedQuestions.value = questions
    })
    .catch(() => { suggestedQuestions.value = [] })
}

function next() {
  if (step.value === 1 && !selectedAgentId.value) return
  if (step.value === 2 && sampleText.value.trim() === '') {
    sampleText.value = suggestedQuestions.value[0] || DEFAULT_SAMPLE_PROMPT
  }
  step.value += 1
}

function finish() {
  emit('complete', { chosenAgentId: selectedAgentId.value, sampleText: sampleText.value })
}
</script>

<style scoped>
.onboarding-overlay {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: 16px;
}

.wizard-card {
  width: min(560px, 100%);
  max-height: 86%;
  overflow: auto;
  background: var(--aw-surface);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.wizard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.wizard-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--aw-ink);
}

.wizard-steps {
  display: flex;
  gap: 6px;
}

.step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--aw-border);
}

.step-dot.active {
  background: var(--aw-primary);
}

.step-dot.done {
  background: var(--aw-primary-line);
}

.wizard-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 180px;
}

.wizard-hint {
  margin: 0;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.wizard-hint.subtle {
  font-size: 12px;
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.agent-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--aw-border);
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.agent-card.selected {
  border-color: var(--aw-primary);
  box-shadow: 0 0 0 1px var(--aw-primary);
}

.agent-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
}

.default-tag {
  flex-shrink: 0;
}

.agent-desc {
  font-size: 12px;
  color: var(--aw-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.agent-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.mode-card {
  padding: 14px;
  border: 1px solid var(--aw-border);
  border-radius: 10px;
}

.mode-card h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--aw-ink);
}

.mode-card p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aw-ink-muted);
}

.wizard-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-spacer {
  flex: 1;
}

.skip-btn {
  color: var(--aw-ink-muted);
}
</style>
