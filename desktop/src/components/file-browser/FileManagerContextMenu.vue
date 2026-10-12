<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="file-tree-context-menu"
      :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
      @click="hide"
    >
      <template v-if="isMulti">
        <div class="context-menu-item" @click="$emit('remove')"><el-icon><Delete /></el-icon><span>删除（{{ selectedCount }} 项）</span></div>
        <div class="context-menu-item" @click="$emit('cut')"><el-icon><Scissor /></el-icon><span>剪切</span></div>
        <div class="context-menu-item" @click="$emit('copy')"><el-icon><DocumentCopy /></el-icon><span>复制</span></div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" @click="$emit('download')"><el-icon><Download /></el-icon><span>下载（{{ selectedCount }} 项）</span></div>
        <div class="context-menu-item" @click="$emit('copy-path')"><el-icon><DocumentCopy /></el-icon><span>复制绝对路径</span></div>
        <div class="context-menu-item" @click="$emit('add-to-chat')"><el-icon><ChatDotRound /></el-icon><span>添加到聊天</span></div>
      </template>
      <template v-else-if="entry">
        <div class="context-menu-item" @click="$emit('open')"><el-icon><View /></el-icon><span>打开</span></div>
        <template v-if="entry.isDirectory">
          <div class="context-menu-item" @click="$emit('create-file')"><el-icon><DocumentAdd /></el-icon><span>新建文件</span></div>
          <div class="context-menu-item" @click="$emit('create-dir')"><el-icon><FolderAdd /></el-icon><span>新建文件夹</span></div>
          <div class="context-menu-item" @click="$emit('upload-here')"><el-icon><Upload /></el-icon><span>上传到此处</span></div>
        </template>
        <div class="context-menu-item" @click="$emit('rename')"><el-icon><EditPen /></el-icon><span>重命名</span></div>
        <div class="context-menu-item" @click="$emit('remove')"><el-icon><Delete /></el-icon><span>删除</span></div>
        <div class="context-menu-item" @click="$emit('cut')"><el-icon><Scissor /></el-icon><span>剪切</span></div>
        <div class="context-menu-item" @click="$emit('copy')"><el-icon><DocumentCopy /></el-icon><span>复制</span></div>
        <div v-if="canPaste" class="context-menu-item" @click="$emit('paste')"><el-icon><CopyDocument /></el-icon><span>粘贴</span></div>
        <div class="context-menu-divider"></div>
        <div v-if="entry.isDirectory" class="context-menu-item" @click="$emit('download-zip')"><el-icon><Download /></el-icon><span>下载此目录（zip）</span></div>
        <div v-else class="context-menu-item" @click="$emit('download')"><el-icon><Download /></el-icon><span>下载此文件</span></div>
        <div class="context-menu-item" @click="$emit('copy-path')"><el-icon><DocumentCopy /></el-icon><span>复制绝对路径</span></div>
        <div class="context-menu-item" @click="$emit('add-to-chat')"><el-icon><ChatDotRound /></el-icon><span>添加到聊天</span></div>
        <div class="context-menu-item" @click="$emit('locate')"><el-icon><Position /></el-icon><span>在文件树中显示</span></div>
      </template>
      <template v-else>
        <div class="context-menu-item" @click="$emit('create-file')"><el-icon><DocumentAdd /></el-icon><span>新建文件</span></div>
        <div class="context-menu-item" @click="$emit('create-dir')"><el-icon><FolderAdd /></el-icon><span>新建文件夹</span></div>
        <div class="context-menu-item" @click="$emit('upload-here')"><el-icon><Upload /></el-icon><span>上传到此处</span></div>
        <div v-if="canPaste" class="context-menu-item" @click="$emit('paste')"><el-icon><CopyDocument /></el-icon><span>粘贴</span></div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" @click="$emit('select-all')"><el-icon><Finished /></el-icon><span>全选</span></div>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ChatDotRound, CopyDocument, Delete, DocumentAdd, DocumentCopy, Download, EditPen,
  FolderAdd, Position, Scissor, View,
} from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  entry: FileNode | null
  selectedCount: number
  canPaste: boolean
}>()

const emit = defineEmits<{
  hide: []
  open: []
  'create-file': []
  'create-dir': []
  'upload-here': []
  rename: []
  remove: []
  cut: []
  copy: []
  paste: []
  download: []
  'download-zip': []
  'copy-path': []
  'add-to-chat': []
  locate: []
  'select-all': []
}>()

const isMulti = computed(() => props.selectedCount > 1)

const menuRef = ref<HTMLDivElement>()
const adjustedX = ref(props.x)
const adjustedY = ref(props.y)

watch(() => [props.visible, props.x, props.y] as const, async ([vis, px, py]) => {
  if (!vis) return
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
