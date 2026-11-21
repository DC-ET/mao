<template>
  <div class="browser-live" :class="[`variant-${variant}`, { draggable: variant === 'pip' }]">
    <header class="live-header">
      <span v-if="variant === 'pip'" class="drag-spacer" aria-hidden="true"></span>
      <span class="live-title" :title="state?.pageUrl || ''">{{ title }}</span>
      <span v-if="state?.cliSession && state.cliSession !== 'default'" class="cli-chip">{{ state.cliSession }}</span>
      <span class="header-actions" :class="{ 'no-drag': variant === 'pip' }">
        <el-popconfirm
          v-if="state?.isLive"
          title="停止浏览器？Agent 后续的浏览器操作将失败。"
          confirm-button-text="停止"
          cancel-button-text="取消"
          width="240"
          @confirm="onStop"
        >
          <template #reference>
            <button class="icon-btn" type="button" aria-label="停止浏览器" title="停止浏览器">
              <el-icon><CircleCloseFilled /></el-icon>
            </button>
          </template>
        </el-popconfirm>
        <button
          v-if="variant === 'tab' && isElectron"
          class="icon-btn"
          type="button"
          aria-label="还原为画中画窗口"
          title="还原为画中画窗口"
          @click="onRestore"
        >
          <el-icon><CopyDocument /></el-icon>
        </button>
      </span>
    </header>

    <div
      class="live-body"
      :class="{ 'no-drag': variant === 'pip' }"
      @dblclick="onDblClick"
    >
      <canvas
        v-show="state?.frame"
        ref="canvasRef"
        class="live-canvas"
      ></canvas>
      <div v-if="!state?.frame" class="live-placeholder">
        <template v-if="state?.stoppedReason">
          <p class="placeholder-main">直播已结束</p>
          <p class="placeholder-sub">{{ stopReasonText }}</p>
        </template>
        <template v-else>
          <p class="placeholder-main">等待 Agent 打开浏览器…</p>
          <p class="placeholder-sub">Agent 使用 browser-use 技能操作浏览器时，画面会实时显示在这里</p>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 浏览器直播视图（方案 2026-11-20 v2 D4/D10）：画中画窗口（variant=pip，可拖动、双击放大）
 * 与主窗直播 Tab（variant=tab，可还原回画中画）共用同一组件。帧数据一律来自
 * browserLiveStore（Electron 下由主进程枢纽扇出；Web 下由 useStreamWS 直喂）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElIcon } from 'element-plus'
import { CircleCloseFilled, CopyDocument } from '@element-plus/icons-vue'
import { useBrowserLiveStore } from '../../stores/browserLive'
import { isElectronClient } from '../../utils/platform'

const props = withDefaults(defineProps<{
  variant: 'pip' | 'tab'
  /** 指定观看的会话（Tab 宿主传的是 string 形态的会话 id）；缺省跟随最近活跃直播 */
  sessionId?: number | string | null
}>(), { sessionId: null })

const store = useBrowserLiveStore()
const isElectron = isElectronClient()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const numericSessionId = computed<number | null>(() => {
  const raw = props.sessionId ?? store.activeSessionId
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
})
const state = computed(() => {
  return numericSessionId.value != null ? store.sessions[String(numericSessionId.value)] ?? null : null
})

const title = computed(() => {
  if (!state.value) return '浏览器直播'
  if (state.value.stoppedReason && !state.value.isLive) return '浏览器直播 · 已结束'
  if (!state.value.pageUrl) return '浏览器直播'
  let url = state.value.pageUrl
  try {
    const parsed = new URL(url)
    url = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch { /* 非 URL 原样展示（截断交给 CSS） */ }
  return url.length > 60 ? `${url.slice(0, 60)}…` : url
})

const STOP_REASON_TEXT: Record<string, string> = {
  browser_exit: '浏览器已关闭',
  session_end: '任务已结束',
  user_stop: '已手动停止浏览器',
  timeout: '直播超时',
  runner_exit: '直播进程退出',
}
const stopReasonText = computed(() => {
  const reason = state.value?.stoppedReason
  return reason ? STOP_REASON_TEXT[reason] ?? `原因：${reason}` : ''
})

// 只画最新帧：图像异步加载完成即覆盖画布，乱序/旧帧由 store 侧丢弃
let lastDrawnFrame: string | null = null
let pendingImage: HTMLImageElement | null = null
watch(() => state.value?.frame, (frame) => {
  if (!frame || frame === lastDrawnFrame || !canvasRef.value) return
  lastDrawnFrame = frame
  const img = new Image()
  pendingImage = img
  img.onload = () => {
    if (pendingImage !== img || !canvasRef.value) return
    const canvas = canvasRef.value
    canvas.width = img.naturalWidth || state.value?.width || canvas.clientWidth
    canvas.height = img.naturalHeight || state.value?.height || canvas.clientHeight
    const ctx = canvas.getContext('2d')
    ctx?.drawImage(img, 0, 0, canvas.width, canvas.height)
  }
  img.src = `data:image/jpeg;base64,${frame}`
})

function onDblClick() {
  if (props.variant === 'pip' && isElectron) {
    ;(window as any).electronAPI?.browserLive?.expand()
  }
}

function onStop() {
  store.stopBrowser(numericSessionId.value)
}

function onRestore() {
  store.restorePip()
}

onBeforeUnmount(() => {
  pendingImage = null
})
</script>

<style scoped>
.browser-live {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #101014;
  color: #e6e6eb;
  overflow: hidden;
  min-height: 0;
}
.variant-pip {
  border-radius: 10px;
}
.draggable {
  cursor: default;
}
/* 画中画：头部整条可拖动窗口（方案 D4），交互元素以 no-drag 排除 */
.variant-pip.draggable .live-header {
  -webkit-app-region: drag;
}
.variant-pip .no-drag {
  -webkit-app-region: no-drag;
}
.live-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 8px;
  background: #1a1a21;
  flex: none;
}
.drag-spacer {
  width: 52px;
  flex: none;
}
.live-title {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.cli-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #2c2c36;
  color: #a8a8b8;
  flex: none;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #a8a8b8;
  cursor: pointer;
  padding: 0;
}
.icon-btn:hover {
  background: #2c2c36;
  color: #e6e6eb;
}
.live-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #101014;
}
.live-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.live-placeholder {
  padding: 12px;
  text-align: center;
  color: #6e6e80;
}
.placeholder-main {
  font-size: 13px;
  margin: 0 0 6px;
  color: #9a9aae;
}
.placeholder-sub {
  font-size: 11px;
  margin: 0;
  max-width: 240px;
}
</style>
