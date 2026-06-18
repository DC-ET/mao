<template>
  <div v-if="visible" class="file-reference-panel" @mousedown.prevent>
    <div v-if="loading" class="panel-loading">
      <span class="loading-text">搜索文件中...</span>
    </div>
    <div v-else-if="files.length === 0" class="panel-empty">
      {{ filter ? '未找到匹配的文件' : '工作区内暂无文件' }}
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
import { ref, watch, nextTick } from 'vue'

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

watch(() => props.visible, (val) => {
  if (val) selectedIndex.value = 0
})

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
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
  z-index: 100;
  margin-bottom: 4px;
}

[data-theme="dark"] .file-reference-panel {
  background: var(--aw-canvas-parchment);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
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
