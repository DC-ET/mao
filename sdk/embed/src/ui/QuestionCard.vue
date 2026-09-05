<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WsAskUserQuestionAnswer } from '@mao/contracts';
import type { PendingQuestion } from '../types';

const props = defineProps<{ pending: PendingQuestion; submitting: boolean }>();
const emit = defineEmits<{ submit: [requestId: string, answers: WsAskUserQuestionAnswer[]] }>();

/** 每题的已选下标；单选题至多一个 */
const selected = ref<number[][]>(props.pending.questions.map(() => []));
/** 每题的自定义输入（对应工具 outputSchema 的 customInput） */
const customInputs = ref<string[]>(props.pending.questions.map(() => ''));

watch(
  () => props.pending.requestId,
  () => {
    selected.value = props.pending.questions.map(() => []);
    customInputs.value = props.pending.questions.map(() => '');
  },
);

const canSubmit = computed(() =>
  props.pending.questions.every((q, i) => {
    const sel = selected.value[i] ?? [];
    // 自定义输入可替代选项作答（对齐 desktop：两者任一有值即可提交）
    if ((customInputs.value[i] ?? '').trim()) return true;
    return q.multiSelect ? sel.length > 0 : sel.length === 1;
  }),
);

function isChecked(qi: number, oi: number): boolean {
  return (selected.value[qi] ?? []).includes(oi);
}

function toggle(qi: number, oi: number) {
  const q = props.pending.questions[qi];
  const current = selected.value[qi] ?? [];
  let next: number[];
  if (q.multiSelect) {
    next = current.includes(oi) ? current.filter((x) => x !== oi) : [...current, oi].sort((a, b) => a - b);
  } else {
    next = [oi];
  }
  selected.value = selected.value.map((v, i) => (i === qi ? next : v));
}

function onCustomFocus(qi: number) {
  // 单选题：改用自定义输入即清空选项（与 desktop QuestionPanel 一致）
  if (!props.pending.questions[qi]?.multiSelect) {
    selected.value = selected.value.map((v, i) => (i === qi ? [] : v));
  }
}

function submit() {
  if (!canSubmit.value || props.submitting) return;
  // answers 形状必须匹配 ask_user_questions 工具的 outputSchema
  const answers: WsAskUserQuestionAnswer[] = props.pending.questions.map((q, qi) => ({
    question: q.question,
    selectedLabels: (selected.value[qi] ?? []).map((oi) => q.options[oi]?.label ?? '').filter(Boolean),
    customInput: (customInputs.value[qi] ?? '').trim() || null,
  }));
  emit('submit', props.pending.requestId, answers);
}
</script>

<template>
  <div class="mao-card">
    <div class="mao-card__title">Agent 需要你的输入</div>
    <div v-for="(q, qi) in pending.questions" :key="qi" class="mao-q__item">
      <div class="mao-q__label">{{ q.header ? `${q.header}：` : '' }}{{ q.question }}</div>
      <label
        v-for="(opt, oi) in q.options"
        :key="oi"
        class="mao-q__opt"
        :class="{ 'mao-q__opt--checked': isChecked(qi, oi) }"
      >
        <input
          :type="q.multiSelect ? 'checkbox' : 'radio'"
          :name="`mao-q-${pending.requestId}-${qi}`"
          :checked="isChecked(qi, oi)"
          :disabled="submitting"
          @change="toggle(qi, oi)"
        />
        <span>
          {{ opt.label }}
          <span v-if="opt.description" class="mao-q__desc">— {{ opt.description }}</span>
        </span>
      </label>
      <input
        v-model="customInputs[qi]"
        class="mao-q__custom"
        type="text"
        :disabled="submitting"
        placeholder="其他（可自行填写）"
        @focus="onCustomFocus(qi)"
      />
    </div>
    <div class="mao-card__actions">
      <button
        class="mao-btn mao-btn--primary"
        type="button"
        :disabled="!canSubmit || submitting"
        @click="submit"
      >
        {{ submitting ? '已提交' : '提交' }}
      </button>
    </div>
  </div>
</template>
