<script setup lang="ts">
import { ref } from 'vue';
import type { EmbedSessionListItem } from '../controller';
import { formatRelativeTime } from './historyTime';

const props = defineProps<{
  open: boolean;
  items: EmbedSessionListItem[];
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  /** 当前活跃会话 id：列表项高亮 */
  activeSessionId: number | null;
}>();

const emit = defineEmits<{
  select: [id: number];
  newSession: [];
  loadMore: [];
  close: [];
}>();

const listEl = ref<HTMLElement | null>(null);

function onScroll() {
  const el = listEl.value;
  if (!el || props.loading || !props.hasMore) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) emit('loadMore');
}
</script>

<template>
  <div v-if="open" class="mao-history" role="dialog" aria-label="历史对话">
    <div class="mao-history__head">
      <span class="mao-history__title">历史对话</span>
      <button class="mao-panel__btn" type="button" title="收起" @click="emit('close')">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="mao-history__new" role="button" tabindex="0" @click="emit('newSession')">
      <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      <span>新对话</span>
    </div>
    <div v-if="error" class="mao-history__error">{{ error }}</div>
    <div v-else-if="loading && items.length === 0" class="mao-history__empty">加载中…</div>
    <div v-else-if="items.length === 0" class="mao-history__empty">暂无历史对话</div>
    <div v-else ref="listEl" class="mao-history__list" @scroll.passive="onScroll">
      <div
        v-for="item in items"
        :key="item.id"
        class="mao-history__item"
        :class="{ 'mao-history__item--active': item.id === activeSessionId }"
        role="button"
        tabindex="0"
        @click="emit('select', item.id)"
        @keydown.enter="emit('select', item.id)"
      >
        <span class="mao-history__item-title">{{ item.title ?? '未命名会话' }}</span>
        <span class="mao-history__item-time">{{ formatRelativeTime(item.updatedAt) }}</span>
      </div>
      <div v-if="loading" class="mao-history__more">加载中…</div>
      <div v-else-if="hasMore" class="mao-history__more" role="button" tabindex="0" @click="emit('loadMore')">加载更多</div>
      <div v-else class="mao-history__more">没有更多了</div>
    </div>
  </div>
</template>
