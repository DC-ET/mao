<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PendingQuestion } from '../types';

const props = defineProps<{ pending: PendingQuestion }>();
const emit = defineEmits<{ submit: [requestId: string, answers: unknown[]] }>();

interface Choice {
  indexes: Set<number>;
}

const choices = ref<Choice[]>(props.pending.questions.map(() => ({ indexes: new Set<number>() })));

watch(
  () => props.pending.requestId,
  () => {
    choices.value = props.pending.questions.map(() => ({ indexes: new Set<number>() }));
  },
);

const canSubmit = computed(() =>
  props.pending.questions.every((q, i) => {
    const sel = choices.value[i]?.indexes;
    return sel != null && (q.multiSelect ? sel.size > 0 : sel.size === 1);
  }),
);

function toggle(qi: number, oi: number) {
  const q = props.pending.questions[qi];
  const sel = choices.value[qi].indexes;
  if (q.multiSelect) {
    if (sel.has(oi)) sel.delete(oi);
    else sel.add(oi);
  } else {
    sel.clear();
    sel.add(oi);
  }
  // 触发响应式更新
  choices.value[qi] = { indexes: new Set(sel) };
}

function submit() {
  const answers = props.pending.questions.map((q, qi) => {
    const sel = Array.from(choices.value[qi].indexes).sort((a, b) => a - b);
    return sel.map((oi) => {
      const opt = q.options[oi];
      return { label: opt.label, description: opt.description ?? null };
    });
  });
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
        :class="{ 'mao-q__opt--checked': choices[qi]?.indexes.has(oi) }"
      >
        <input
          type="checkbox"
          :checked="choices[qi]?.indexes.has(oi)"
          @change="toggle(qi, oi)"
        />
        <span>
          {{ opt.label }}
          <span v-if="opt.description" class="mao-q__desc">— {{ opt.description }}</span>
        </span>
      </label>
    </div>
    <div class="mao-card__actions">
      <button class="mao-btn mao-btn--primary" type="button" :disabled="!canSubmit" @click="submit">
        提交
      </button>
    </div>
  </div>
</template>
