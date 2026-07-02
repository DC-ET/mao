<template>
  <div v-if="items.length > 0" class="question-panel">
    <div class="panel-header">
      <el-icon class="header-icon" :size="12"><ChatDotRound /></el-icon>
      <span class="header-label">Agent 想了解：</span>
      <span v-if="items.length > 1" class="header-badge">{{ items.length }}</span>
    </div>

    <div class="question-card">
      <!-- Tabs for multiple questions -->
      <div v-if="currentQuestions.length > 1" class="question-tabs">
        <button
          v-for="(q, qi) in currentQuestions"
          :key="qi"
          class="tab-btn"
          :class="{
            active: activeTab === qi,
            answered: answeredTabs[qi]
          }"
          @click="activeTab = qi"
        >
          <span class="tab-index">{{ qi + 1 }}</span>
          <span class="tab-label">{{ q.header }}</span>
          <el-icon v-if="answeredTabs[qi]" :size="10" class="tab-check"><Check /></el-icon>
        </button>
      </div>

      <!-- Current question content — key on activeTab forces full re-render on tab switch -->
      <div
        v-if="currentQuestions[activeTab]"
        :key="activeTab"
        class="question-group"
        :class="{ 'has-preview': hasPreview(currentQuestions[activeTab]) && !currentQuestions[activeTab].multiSelect }"
      >
        <div class="question-main">
          <div v-if="currentQuestions.length === 1" class="question-header">
            <span class="question-tag">{{ currentQuestions[activeTab].header }}</span>
          </div>
          <p class="question-text">{{ currentQuestions[activeTab].question }}</p>

          <div class="options-list">
            <button
              v-for="(opt, oi) in currentQuestions[activeTab].options"
              :key="oi"
              class="option-btn"
              :class="{
                selected: isSelected(activeTab, opt.label),
                'has-preview': hasPreview(currentQuestions[activeTab]) && !currentQuestions[activeTab].multiSelect
              }"
              @click="selectOption(activeTab, opt.label, currentQuestions[activeTab].multiSelect)"
            >
              <span class="option-radio">
                <template v-if="currentQuestions[activeTab].multiSelect">
                  <el-icon v-if="isSelected(activeTab, opt.label)" :size="10"><Check /></el-icon>
                </template>
                <template v-else>
                  <span v-if="isSelected(activeTab, opt.label)" class="radio-dot" />
                </template>
              </span>
              <span class="option-content">
                <span class="option-label">{{ opt.label }}</span>
                <span class="option-desc">{{ opt.description }}</span>
              </span>
            </button>
          </div>

          <div class="other-input">
            <span class="option-radio">
              <template v-if="currentQuestions[activeTab].multiSelect">
                <el-icon v-if="getCustomInput(activeTab)" :size="10"><Check /></el-icon>
              </template>
              <template v-else>
                <span v-if="getCustomInput(activeTab)" class="radio-dot" />
              </template>
            </span>
            <input
              v-model="customInputs[activeTab]"
              class="other-field"
              placeholder="其他回答..."
              @input="onCustomInput(activeTab)"
              @focus="onCustomFocus(activeTab)"
            />
          </div>
        </div>

        <!-- Preview panel -->
        <div v-if="hasPreview(currentQuestions[activeTab]) && !currentQuestions[activeTab].multiSelect" class="preview-panel">
          <MarkdownContent
            v-if="getSelectedPreview(activeTab)"
            :content="getSelectedPreview(activeTab)!"
            body-class="preview-content markdown-body"
          />
          <div v-else class="preview-placeholder">选择一个选项查看预览</div>
        </div>
      </div>

      <div class="panel-actions">
        <button
          v-if="allAnswered"
          class="action-btn submit"
          :disabled="!canSubmit"
          @click="handleSubmit"
        >
          提交
        </button>
        <button
          v-else
          class="action-btn confirm"
          :class="{ disabled: !isCurrentAnswered }"
          @click="isCurrentAnswered && confirmAndNext()"
        >
          确定
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { ChatDotRound, Check } from '@element-plus/icons-vue'
import type { PendingQuestion, Question, QuestionAnswer } from '../../types/chat'
import MarkdownContent from '../common/MarkdownContent.vue'

const props = defineProps<{
  items: PendingQuestion[]
}>()

const emit = defineEmits<{
  submit: [requestId: string, answers: QuestionAnswer[]]
}>()

const activeTab = ref(0)
const answeredTabs = ref<Record<number, boolean>>({})
const selections = ref<Record<number, string[]>>({})
const customInputs = ref<Record<number, string>>({})

const currentRequestId = computed(() => {
  const last = props.items[props.items.length - 1]
  return last?.requestId
})

const currentQuestions = computed<Question[]>(() => {
  const last = props.items[props.items.length - 1]
  return last?.questions ?? []
})

watch(currentRequestId, (_newId, oldId) => {
  if (oldId === undefined) return
  activeTab.value = 0
  answeredTabs.value = {}
  selections.value = {}
  customInputs.value = {}
})

onMounted(() => {
  const questions = currentQuestions.value
  if (questions.length > 1) {
    const firstUnanswered = questions.findIndex((_q, qi) => !isQuestionAnswered(qi))
    if (firstUnanswered >= 0) {
      activeTab.value = firstUnanswered
    }
  }
})

function isSelected(qi: number, label: string): boolean {
  return (selections.value[qi] ?? []).includes(label)
}

function getCustomInput(qi: number): string {
  return customInputs.value[qi] ?? ''
}

function isQuestionAnswered(qi: number): boolean {
  const hasSelection = (selections.value[qi] ?? []).length > 0
  const custom = (customInputs.value[qi] ?? '').trim()
  return hasSelection || custom.length > 0
}

const isCurrentAnswered = computed(() => isQuestionAnswered(activeTab.value))

const allAnswered = computed(() => {
  if (currentQuestions.value.length === 0) return false
  return currentQuestions.value.every((_q, qi) => isQuestionAnswered(qi))
})

const canSubmit = computed(() => {
  if (currentQuestions.value.length === 0) return false
  return currentQuestions.value.every((_q, qi) => {
    const hasSelection = (selections.value[qi] ?? []).length > 0
    const custom = (customInputs.value[qi] ?? '').trim()
    return hasSelection || custom.length > 0
  })
})

function selectOption(qi: number, label: string, multiSelect: boolean) {
  if (multiSelect) {
    const current = selections.value[qi] ?? []
    if (current.includes(label)) {
      selections.value = { ...selections.value, [qi]: current.filter(l => l !== label) }
    } else {
      selections.value = { ...selections.value, [qi]: [...current, label] }
    }
  } else {
    customInputs.value = { ...customInputs.value, [qi]: '' }
    selections.value = { ...selections.value, [qi]: [label] }
  }
}

function onCustomInput(qi: number) {
  const q = currentQuestions.value[qi]
  if (q && !q.multiSelect && customInputs.value[qi]) {
    selections.value = { ...selections.value, [qi]: [] }
  }
}

function onCustomFocus(qi: number) {
  const q = currentQuestions.value[qi]
  if (q && !q.multiSelect) {
    selections.value = { ...selections.value, [qi]: [] }
  }
}

function hasPreview(q: Question): boolean {
  return q.options.some(o => !!o.preview)
}

function getSelectedPreview(qi: number): string | null {
  const sel = selections.value[qi]
  if (!sel || sel.length !== 1) return null
  const label = sel[0]
  const q = currentQuestions.value[qi]
  if (!q) return null
  const opt = q.options.find(o => o.label === label)
  return opt?.preview ?? null
}

function confirmAndNext() {
  answeredTabs.value = { ...answeredTabs.value, [activeTab.value]: true }
  const total = currentQuestions.value.length
  for (let i = 1; i <= total; i++) {
    const next = (activeTab.value + i) % total
    if (!answeredTabs.value[next] || next === activeTab.value) {
      activeTab.value = next
      break
    }
  }
}

function handleSubmit() {
  if (!canSubmit.value || !currentRequestId.value) return

  const answers: QuestionAnswer[] = currentQuestions.value.map((q, qi) => {
    const selectedLabels = selections.value[qi] ?? []
    const customInput = (customInputs.value[qi] ?? '').trim() || null
    return {
      question: q.question,
      selectedLabels,
      customInput
    }
  })

  emit('submit', currentRequestId.value, answers)
}
</script>

<style scoped>
.question-panel {
  flex-shrink: 0;
  margin-bottom: 8px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding: 0 2px;
}

.header-icon {
  color: var(--aw-primary);
  flex-shrink: 0;
}

.header-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--aw-ink);
}

.header-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--aw-primary);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.question-card {
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-md);
  padding: 10px 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

/* Tabs */
.question-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--aw-hairline);
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  border-radius: var(--aw-radius-sm);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: var(--aw-ink-muted-60);
  transition: all 0.15s;
}

.tab-btn:hover {
  background: color-mix(in srgb, var(--aw-primary) 6%, transparent);
}

.tab-btn.active {
  border-color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 8%, transparent);
  color: var(--aw-primary);
  font-weight: 600;
}

.tab-btn.answered {
  color: var(--aw-ink);
}

.tab-btn.answered.active {
  color: var(--aw-primary);
}

.tab-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aw-hairline);
  font-size: 10px;
  font-weight: 600;
  color: var(--aw-ink-muted-60);
  flex-shrink: 0;
}

.tab-btn.active .tab-index {
  background: var(--aw-primary);
  color: #fff;
}

.tab-btn.answered .tab-index {
  background: color-mix(in srgb, var(--aw-primary) 15%, transparent);
  color: var(--aw-primary);
}

.tab-btn.answered.active .tab-index {
  background: var(--aw-primary);
  color: #fff;
}

.tab-label {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-check {
  color: var(--aw-primary);
  flex-shrink: 0;
}

/* Question content */
.question-group {
  margin-bottom: 4px;
}

.question-group.has-preview {
  display: flex;
  gap: 10px;
}

.question-main {
  flex: 1;
  min-width: 0;
}

.question-header {
  margin-bottom: 4px;
}

.question-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--aw-radius-xs);
  background: color-mix(in srgb, var(--aw-primary) 10%, transparent);
  color: var(--aw-primary);
  font-size: 10px;
  font-weight: 600;
}

.question-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--aw-ink);
  line-height: 1.4;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 6px;
}

.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-canvas);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
}

.option-btn:hover {
  border-color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 4%, transparent);
}

.option-btn.selected {
  border-color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 8%, transparent);
}

.option-radio {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--aw-hairline);
  border-radius: 50%;
  color: var(--aw-primary);
}

.option-btn.selected .option-radio {
  border-color: var(--aw-primary);
  background: var(--aw-primary);
  color: #fff;
}

.radio-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aw-primary);
}

.option-btn.selected .radio-dot {
  background: #fff;
}

.option-content {
  flex: 1;
  min-width: 0;
}

.option-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--aw-ink);
  line-height: 1.4;
}

.option-desc {
  display: block;
  font-size: 11px;
  color: var(--aw-ink-muted-60);
  line-height: 1.4;
  margin-top: 1px;
}

.other-input {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-canvas);
  transition: border-color 0.15s, background 0.15s;
  cursor: text;
}

.other-input:focus-within {
  border-color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 4%, transparent);
}

.other-field {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--aw-ink);
  outline: none;
}

.other-field::placeholder {
  color: var(--aw-ink-muted-40);
}

.preview-panel {
  flex: 1;
  min-width: 0;
  max-width: 50%;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-canvas);
  overflow: auto;
  max-height: 200px;
}

.preview-content {
  padding: 8px 10px;
  font-family: var(--aw-font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.preview-content :deep(pre) {
  margin: 0;
  background: none;
}

.preview-content :deep(code) {
  font-family: var(--aw-font-mono);
}

.preview-placeholder {
  padding: 16px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--aw-ink-muted-40);
}

.panel-actions {
  padding-top: 6px;
  border-top: 1px solid var(--aw-hairline);
}

.action-btn {
  width: 100%;
  height: 28px;
  padding: 0;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  transform: scale(1.04);
}

.action-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-btn.confirm {
  border-color: var(--aw-primary);
  color: #fff;
  background: var(--aw-primary);
}

.action-btn.confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--aw-primary) 85%, transparent);
}

.action-btn.submit {
  border-color: var(--aw-primary);
  color: #fff;
  background: var(--aw-primary);
}

.action-btn.submit:hover:not(:disabled) {
  background: color-mix(in srgb, var(--aw-primary) 85%, transparent);
}
</style>
