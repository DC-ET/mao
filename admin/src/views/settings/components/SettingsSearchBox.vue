<template>
  <div ref="rootRef" class="settings-search">
    <el-input
      v-model="query"
      clearable
      placeholder="搜索配置，例如空闲超时、SMTP、harness.shell"
      aria-label="搜索系统设置"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="panelOpen"
      aria-controls="settings-search-list"
      @focus="open = true"
      @keydown.down.prevent="moveActive(1)"
      @keydown.up.prevent="moveActive(-1)"
      @keydown.enter="confirmActive"
      @keydown.esc="open = false"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
    </el-input>
    <div v-if="panelOpen" id="settings-search-list" class="search-panel" role="listbox">
      <button
        v-for="(hit, index) in result.hits"
        :key="`${hit.fieldId}-${hit.sectionHit ? 'section' : 'field'}`"
        type="button"
        class="search-hit"
        role="option"
        :aria-selected="index === activeIndex"
        :class="{ active: index === activeIndex }"
        @mouseenter="activeIndex = index"
        @mousedown.prevent
        @click="choose(hit)"
      >
        <span class="hit-label">
          <span class="hit-title">
            <template v-for="(part, partIndex) in highlightSegments(hit.label, query)" :key="partIndex">
              <mark v-if="part.mark">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
          <span v-if="hit.sectionHit" class="hit-kind">这一组</span>
        </span>
        <span class="hit-meta">
          <span class="hit-path">{{ hit.group }} / {{ hit.section }}</span>
          <span v-if="hit.key" class="hit-key">{{ hit.key }}</span>
        </span>
      </button>
      <div v-if="result.hits.length === 0" class="search-empty">没有匹配的配置</div>
      <div v-else-if="result.total > result.hits.length" class="search-more">
        还有 {{ result.total - result.hits.length }} 条，请把关键词写得更具体
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import {
  highlightSegments,
  searchSettings,
  type LocatorField,
  type LocatorSection,
  type SearchHit,
} from '../settingsLocator'

const props = defineProps<{
  fields: LocatorField[]
  sections: LocatorSection[]
}>()

const emit = defineEmits<{ select: [hit: SearchHit] }>()

const rootRef = ref<HTMLElement | null>(null)
const query = ref('')
const open = ref(false)
const activeIndex = ref(0)

const result = computed(() => searchSettings(props.fields, props.sections, query.value))
const panelOpen = computed(() => open.value && query.value.trim() !== '')

watch(result, () => {
  activeIndex.value = 0
})

watch(activeIndex, () => {
  nextTick(() => {
    const panel = rootRef.value?.querySelector('.search-panel')
    const active = rootRef.value?.querySelector('.search-hit.active')
    if (!panel || !(active instanceof HTMLElement)) return
    const panelRect = panel.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    if (itemRect.top < panelRect.top) panel.scrollTop -= panelRect.top - itemRect.top
    else if (itemRect.bottom > panelRect.bottom) panel.scrollTop += itemRect.bottom - panelRect.bottom
  })
})

function moveActive(step: number) {
  open.value = true
  const count = result.value.hits.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + step + count) % count
}

function confirmActive(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  const hit = result.value.hits[activeIndex.value]
  if (hit) choose(hit)
}

function choose(hit: SearchHit) {
  open.value = false
  query.value = ''
  emit('select', hit)
}

function onPointerDown(event: PointerEvent) {
  const root = rootRef.value
  if (!root || !open.value) return
  if (event.target instanceof Node && root.contains(event.target)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown)
})
</script>

<style scoped>
.settings-search {
  grid-area: search;
  position: sticky;
  top: 12px;
  z-index: 6;
  width: 100%;
  max-width: 640px;
  background: var(--mao-surface);
}

.search-panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 360px;
  overflow-y: auto;
  background: var(--mao-surface);
  border: 1px solid var(--mao-border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  padding: 4px;
}

.search-hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.search-hit.active {
  background: var(--mao-accent-bg);
}

.hit-label {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--mao-ink);
  line-height: 1.4;
}

.hit-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit-label mark {
  padding: 0;
  background: transparent;
  color: var(--mao-accent);
}

.hit-kind {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--mao-canvas);
  font-size: 11px;
  font-weight: 500;
  color: var(--mao-muted);
}

.hit-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
}

.hit-path {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--mao-muted);
}

.hit-key {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--mao-muted);
}

.search-empty,
.search-more {
  padding: 10px;
  font-size: 12px;
  color: var(--mao-muted);
}
</style>
