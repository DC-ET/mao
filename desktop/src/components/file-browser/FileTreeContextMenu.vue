<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="file-tree-context-menu"
      :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
      @click="hide"
    >
      <div v-if="showLocalActions" class="context-menu-item" @click="$emit('copy-absolute')">
        <el-icon><DocumentCopy /></el-icon>
        <span>复制绝对路径</span>
      </div>
      <div class="context-menu-item" @click="$emit('copy-relative')">
        <el-icon><DocumentCopy /></el-icon>
        <span>复制相对路径</span>
      </div>
      <div v-if="showLocalActions" class="context-menu-divider"></div>
      <div v-if="showLocalActions" class="context-menu-item" @click="$emit('open-in-finder')">
        <el-icon><FolderOpened /></el-icon>
        <span>在 Finder 中打开</span>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" @click="$emit('add-to-chat')">
        <el-icon><ChatDotRound /></el-icon>
        <span>添加到聊天</span>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { DocumentCopy, FolderOpened, ChatDotRound } from '@element-plus/icons-vue'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  showLocalActions?: boolean
}>()

const emit = defineEmits<{
  'copy-absolute': []
  'copy-relative': []
  'open-in-finder': []
  'add-to-chat': []
  hide: []
}>()

const menuRef = ref<HTMLDivElement>()
const adjustedX = ref(props.x)
const adjustedY = ref(props.y)

watch(() => [props.visible, props.x, props.y] as const, async ([vis, px, py]) => {
  if (!vis) return
  // Reset to raw position first so the menu renders at original spot
  adjustedX.value = px
  adjustedY.value = py
  await nextTick()
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 4
  let nx = px
  let ny = py
  if (px + rect.width > window.innerWidth - margin) {
    nx = Math.max(margin, window.innerWidth - rect.width - margin)
  }
  if (py + rect.height > window.innerHeight - margin) {
    ny = Math.max(margin, window.innerHeight - rect.height - margin)
  }
  adjustedX.value = nx
  adjustedY.value = ny
})

function hide() {
  emit('hide')
}

function onGlobalClick() {
  emit('hide')
}

onMounted(() => document.addEventListener('click', onGlobalClick))
onUnmounted(() => document.removeEventListener('click', onGlobalClick))
</script>

<style>
.file-tree-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  padding: 4px 0;
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-divider-soft, #e0e0e0);
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
}

.context-menu-item:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-primary, #0066cc);
}

.context-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--aw-divider-soft, #e0e0e0);
}

[data-theme="dark"] .file-tree-context-menu {
  background: #2a2a2a;
  border-color: var(--aw-hairline, #3a3a3a);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .context-menu-item {
  color: var(--aw-ink, #e0e0e0);
}

[data-theme="dark"] .context-menu-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .context-menu-divider {
  background: var(--aw-hairline, #3a3a3a);
}
</style>
