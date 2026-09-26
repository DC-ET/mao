<template>
  <div v-if="visible" ref="rootRef" class="file-reference-panel" :style="panelStyle" @mousedown.prevent>
    <div v-if="loading" class="panel-loading">
      <span class="loading-text">搜索文件中...</span>
    </div>
    <div v-else-if="files.length === 0 && !filter" class="panel-empty">
      工作区内暂无文件
    </div>
    <template v-else>
      <div class="panel-group">
        <div class="group-label">文件</div>
        <el-tooltip
          v-for="(file, idx) in files"
          :key="file.path"
          :content="file.path"
          placement="top-start"
          :fallback-placements="['top', 'top-end', 'right-start', 'right']"
          :show-after="300"
          popper-class="file-reference-tip"
        >
          <div
            class="panel-item"
            :class="{ active: selectedIndex === idx }"
            @mouseenter="selectedIndex = idx"
            @click="selectItem(file)"
          >
            <span class="item-icon">📄</span>
            <span class="item-name">{{ file.name }}</span>
            <span class="item-path">{{ file.path }}</span>
          </div>
        </el-tooltip>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'

export interface WorkspaceFile {
  path: string
  name: string
  size: number
}

const props = defineProps<{
  visible: boolean
  files: WorkspaceFile[]
  filter: string
  loading?: boolean
}>()

const emit = defineEmits<{
  select: [file: WorkspaceFile]
  close: []
}>()

const selectedIndex = ref(0)
const rootRef = ref<HTMLElement | null>(null)
// 面板向上弹出（bottom: 100%），移动端键盘弹起后上方空间不足会被视口裁掉，
// 打开时动态测量「面板底边到视口顶部」的可用高度收窄 max-height，保证面板完整可见。
const availableHeight = ref<number | null>(null)

const panelStyle = computed(() =>
  availableHeight.value != null ? { maxHeight: `${availableHeight.value}px` } : undefined
)

function measureAvailableHeight() {
  nextTick(() => {
    const el = rootRef.value
    if (!el) return
    const top = el.getBoundingClientRect().top
    // 留 8px 边距，并设下限避免极端情况下面板被压成 0
    availableHeight.value = Math.max(160, Math.ceil(top) - 8)
  })
}

watch(
  () => props.visible,
  (val) => {
    if (val) {
      selectedIndex.value = 0
      availableHeight.value = null
      measureAvailableHeight()
    }
  }
)

watch(
  () => props.files,
  () => {
    selectedIndex.value = 0
    // 文件列表异步加载完成后面板真实底边已确定，需重新测量
    if (props.visible) measureAvailableHeight()
  }
)

watch(() => props.filter, () => {
  selectedIndex.value = 0
})

function selectItem(file: WorkspaceFile) {
  emit('select', file)
}

function moveUp() {
  if (props.files.length === 0) return
  selectedIndex.value = (selectedIndex.value - 1 + props.files.length) % props.files.length
  scrollToSelected()
}

function moveDown() {
  if (props.files.length === 0) return
  selectedIndex.value = (selectedIndex.value + 1) % props.files.length
  scrollToSelected()
}

function confirmSelection() {
  if (props.files.length === 0) return
  const file = props.files[selectedIndex.value]
  if (file) selectItem(file)
}

function scrollToSelected() {
  nextTick(() => {
    const panel = document.querySelector('.file-reference-panel')
    const active = panel?.querySelector('.panel-item.active')
    if (active) {
      active.scrollIntoView({ block: 'nearest' })
    }
  })
}

defineExpose({ moveUp, moveDown, confirmSelection })
</script>

<style scoped>
.file-reference-panel {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  box-shadow: var(--aw-shadow-popover);
  z-index: 100;
  margin-bottom: 4px;
}

[data-theme="dark"] .file-reference-panel {
  background: var(--aw-canvas-parchment);
}

.panel-loading,
.panel-empty {
  padding: 16px;
  text-align: center;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.loading-text::after {
  content: '';
  animation: dots 1.2s steps(3) infinite;
}

@keyframes dots {
  0%, 20% { content: ''; }
  40% { content: '.'; }
  60% { content: '..'; }
  80%, 100% { content: '...'; }
}

.panel-group {
  padding: 4px 0;
}

.group-label {
  padding: 6px 14px 2px;
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink-muted-48);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.panel-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.1s;
  border-radius: 4px;
  margin: 0 4px;
}

.panel-item:hover,
.panel-item.active {
  background: var(--aw-canvas-parchment);
}

[data-theme="dark"] .panel-item:hover,
[data-theme="dark"] .panel-item.active {
  background: rgba(255, 255, 255, 0.06);
}

.item-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.item-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink);
  flex-shrink: 0;
}

.item-path {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.file-reference-tip {
  max-width: 400px;
  word-break: break-word;
}
</style>
