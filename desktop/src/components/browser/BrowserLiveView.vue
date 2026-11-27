<template>
  <div class="browser-live" :class="[`variant-${variant}`, { draggable: variant === 'pip' }]">
    <header class="live-header">
      <span v-if="variant === 'pip'" class="drag-spacer" aria-hidden="true"></span>
      <span class="live-title" :title="state?.pageUrl || ''">{{ title }}</span>
      <span v-if="viewMode === 'live' && state?.cliSession && state.cliSession !== 'default'" class="cli-chip">{{ state.cliSession }}</span>
      <!-- 「Agent 执行中」徽标（决策记录：做，非阻断纯提示）：Agent 的命令可能与用户输入交织 -->
      <span v-if="viewMode === 'live' && agentRunning" class="agent-badge" title="Agent 的命令可能与你的输入交织">Agent 执行中</span>
      <span class="header-actions" :class="{ 'no-drag': variant === 'pip' }">
        <el-tooltip
          v-if="variant === 'tab' && viewMode === 'live' && state?.isLive"
          :content="collabTooltip"
          placement="bottom"
          :show-after="150"
        >
          <!-- 外层 span：禁用按钮不触发鼠标事件，tooltip 挂在包裹层才能展示升级提示 -->
          <span class="icon-btn-wrap">
            <button
              class="icon-btn"
              :class="{ 'collab-on': collabActive }"
              type="button"
              :aria-label="collabActive ? '退出协作操作' : '开启协作操作'"
              :disabled="!canCollab || inputUnsupportedSession"
              @click="toggleCollab"
            >
              <el-icon><Pointer /></el-icon>
            </button>
          </span>
        </el-tooltip>
        <el-popconfirm
          v-if="viewMode === 'live' && state?.isLive"
          title="停止浏览器？Agent 后续的浏览器操作将失败。"
          confirm-button-text="停止"
          cancel-button-text="取消"
          width="240"
          @confirm="onStop"
        >
          <template #reference>
            <!-- 图标按钮统一用 el-tooltip（:show-after 快速出现）；原生 title 提示延迟数秒 -->
            <el-tooltip content="停止浏览器" placement="bottom" :show-after="150">
              <button class="icon-btn" type="button" aria-label="停止浏览器">
                <el-icon><VideoPause /></el-icon>
              </button>
            </el-tooltip>
          </template>
        </el-popconfirm>
        <el-tooltip
          v-if="variant === 'tab' && isElectron && viewMode === 'live' && state?.isLive"
          content="打开画中画"
          placement="bottom"
          :show-after="150"
        >
          <button class="icon-btn" type="button" aria-label="打开画中画" @click="onRestore">
            <el-icon><CopyDocument /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip v-if="viewMode === 'replay'" content="退出回放" placement="bottom" :show-after="150">
          <button class="icon-btn" type="button" aria-label="退出回放" @click="exitReplay">
            <el-icon><Back /></el-icon>
          </button>
        </el-tooltip>
        <!-- 画中画无边框、没有系统关闭键：提供与关窗同语义的收起按钮（仅停止观看），
             避免用户把「停止浏览器」的 ✕ 当成关窗而误杀 Agent 的浏览器 -->
        <el-tooltip v-if="variant === 'pip'" content="关闭画中画（仅停止观看）" placement="bottom" :show-after="150">
          <button class="icon-btn" type="button" aria-label="关闭画中画（仅停止观看）" @click="onHidePip">
            <el-icon><Close /></el-icon>
          </button>
        </el-tooltip>
      </span>
    </header>

    <div
      ref="liveBodyRef"
      class="live-body"
      :class="{ 'no-drag': variant === 'pip' }"
    >
      <template v-if="viewMode === 'live'">
        <canvas
          v-show="state?.frame"
          ref="canvasRef"
          class="live-canvas"
        ></canvas>
        <!-- 协作交互层（方案 2026-11-27 §7.1）：pointer 捕获（setPointerCapture 保证出界
             pointerup 仍回本层）+ 键盘 IME + 全量 preventDefault；PiP 形态永远只读 -->
        <div
          v-if="collabActive"
          ref="overlayRef"
          class="input-overlay"
          tabindex="0"
          role="application"
          aria-label="协作操作画面：鼠标键盘将直接作用于 Agent 的浏览器"
          @pointerdown="onOverlayPointerDown"
          @pointerup="onOverlayPointerUp"
          @pointercancel="onOverlayPointerCancel"
          @pointermove="onOverlayPointerMove"
          @pointerleave="ghostPos = null"
          @wheel.prevent="onOverlayWheel"
          @keydown="onOverlayKeyDown"
          @keyup="onOverlayKeyUp"
          @keypress="onOverlayKeyPress"
          @compositionstart="onCompositionStart"
          @compositionend="onOverlayCompositionEnd"
          @contextmenu.prevent
          @focus="onOverlayFocus"
          @blur="onOverlayBlur"
        ></div>
        <!-- ghost cursor：帧率低时维持「跟手」感，真实光标隐藏（§7.1） -->
        <div v-if="collabActive && ghostPos" class="ghost-cursor" :style="ghostStyle"></div>
        <div v-if="collabActive && frameStale" class="frame-stale-hint">画面延迟较高</div>
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
        <!-- 回放入口（V202 §5.1）：Tab 内非直播态常驻（含结束后定格帧态），画布角落浮层 -->
        <button
          v-if="variant === 'tab' && !state?.isLive"
          type="button"
          class="replay-entry"
          @click="enterReplay"
        >历史回放</button>
      </template>
      <BrowserLiveReplay v-else :session-id="lockedSessionId" />
      <div v-if="viewMode === 'replay' && store.sessions[String(lockedSessionId ?? '')]?.isLive" class="live-resume-banner">
        <span>该会话正在进行新的直播</span>
        <button type="button" class="resume-btn" @click="exitReplay">切回实时</button>
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
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { ElIcon } from 'element-plus'
import { Back, Close, CopyDocument, Pointer, VideoPause } from '@element-plus/icons-vue'
import { useBrowserLiveStore } from '../../stores/browserLive'
import { useSessionStore } from '../../stores/session'
import { isElectronClient } from '../../utils/platform'
import { BrowserInputSender, buildModifiers, detectMacPlatform, translateKeyEvent } from '../../utils/browserLiveInput'
import type { BrowserInputEvent } from '@mao/contracts'
import BrowserLiveReplay from './BrowserLiveReplay.vue'

const props = withDefaults(defineProps<{
  variant: 'pip' | 'tab'
  /** 指定观看的会话（Tab 宿主传的是 string 形态的会话 id）；缺省跟随最近活跃直播 */
  sessionId?: number | string | null
}>(), { sessionId: null })

const store = useBrowserLiveStore()
const sessionStore = useSessionStore()
const isElectron = isElectronClient()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const liveBodyRef = ref<HTMLDivElement | null>(null)
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
  if (viewMode.value === 'replay') return '浏览器回放'
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
/** 当前显示 JPEG 的原始尺寸：协作坐标映射的降级 fallback（frame.width 历史上恒 0 不可用） */
const lastImageSize = ref<{ width: number; height: number } | null>(null)
function drawFrame(frame: string | null | undefined) {
  if (!frame || frame === lastDrawnFrame || !canvasRef.value) return
  lastDrawnFrame = frame
  const img = new Image()
  pendingImage = img
  img.onload = () => {
    if (pendingImage !== img || !canvasRef.value) return
    const canvas = canvasRef.value
    canvas.width = img.naturalWidth || state.value?.width || canvas.clientWidth
    canvas.height = img.naturalHeight || state.value?.height || canvas.clientHeight
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      lastImageSize.value = { width: img.naturalWidth, height: img.naturalHeight }
    }
    const ctx = canvas.getContext('2d')
    ctx?.drawImage(img, 0, 0, canvas.width, canvas.height)
  }
  img.src = `data:image/jpeg;base64,${frame}`
}
// 帧变化即画；另在挂载后补画一次——画中画窗挂载时快照帧可能已就位（store 灌入早于
// 懒加载组件的 watch 注册，immediate 触发时 canvasRef 尚为 null），不补画会黑屏
// 停在等待态（2026-11-21 Windows 真机 smoke）
watch(() => state.value?.frame, (frame) => { drawFrame(frame) })
onMounted(() => {
  drawFrame(state.value?.frame)
  consumeReplayBrowse()
})

// ---------- 回放模式（V202，技术方案 §5.1）----------
// 进入回放后锁定所属会话（BrowserLiveView 缺省跟随 activeSessionId，切会话不漂移）；
// 播放中该会话重新开播只在顶部提示 + 可一键切回实时，不自动打断复盘。
const viewMode = ref<'live' | 'replay'>('live')
const lockedSessionId = ref<number | null>(null)

function enterReplay() {
  lockedSessionId.value = numericSessionId.value
  viewMode.value = 'replay'
}

function exitReplay() {
  viewMode.value = 'live'
  lockedSessionId.value = null
  // canvas 随 viewMode 重新挂载，等渲染完成再补画，否则定格帧缺失
  void nextTick(() => drawFrame(state.value?.frame))
}

/** chip 无直播点击 → Tab 打开后落在回放列表（记账在 store：Tab 在点击后才创建，
 *  实例本地基线会吞掉未消费的请求，见评审 P1-1）。 */
function consumeReplayBrowse() {
  const request = store.consumeReplayBrowse()
  if (!request) return
  const target = request.sessionId != null ? Number(request.sessionId) : numericSessionId.value
  if (target == null || !Number.isFinite(target)) return
  lockedSessionId.value = target
  viewMode.value = 'replay'
}
watch(() => store.replayBrowse.seq, consumeReplayBrowse)

// ---------- 协作操作交互层（技术方案 2026-11-27 §7.1） ----------
// 只在 Tab 形态启用（P-1 后 PiP 永远只读）；开关不记住状态：每次显式开启、退出即失效。
const isMac = detectMacPlatform()
const collabActive = ref(false)
const overlayRef = ref<HTMLDivElement | null>(null)
const ghostPos = ref<{ x: number; y: number } | null>(null)
const frameStale = ref(false)
let sender: BrowserInputSender | null = null
let lastMapped: { x: number; y: number } | null = null
let composing = false
let staleTimer: ReturnType<typeof setInterval> | null = null

const agentRunning = computed(() =>
  numericSessionId.value != null && sessionStore.getSessionPhase(String(numericSessionId.value)) === 'RUNNING'
)
const canCollab = computed(() =>
  props.variant === 'tab'
  && viewMode.value === 'live'
  && state.value?.isLive === true
  && state.value?.startedControl === true
)
const inputUnsupportedSession = computed(() =>
  numericSessionId.value != null && store.inputUnsupported[String(numericSessionId.value)] === true
)
const collabTooltip = computed(() => {
  if (inputUnsupportedSession.value) return '采集端版本过旧，暂不支持协作操作'
  if (state.value?.startedControl !== true) return '采集端升级后支持操作'
  return collabActive.value ? '退出协作操作（Esc）' : '开启协作操作（画面有延迟）'
})
const ghostStyle = computed(() => (ghostPos.value
  ? { left: `${ghostPos.value.x - 5}px`, top: `${ghostPos.value.y - 5}px` }
  : {}))

function toggleCollab() {
  if (collabActive.value) exitCollab()
  else enterCollab()
}

function enterCollab() {
  if (!canCollab.value || inputUnsupportedSession.value) return
  sender?.stop()
  const sid = numericSessionId.value
  sender = new BrowserInputSender((batch) => store.inputBrowser(sid, batch))
  sender.updateFrameMeta(state.value?.frameMeta ?? null, lastImageSize.value)
  collabActive.value = true
  void nextTick(() => overlayRef.value?.focus())
}

function exitCollab() {
  if (!collabActive.value) return
  collabActive.value = false
  sender?.stop() // 冲刷残留 + 全量 keyUp 释放（停止转发的全路径都要防远端卡键，R6）
  sender = null
  ghostPos.value = null
  frameStale.value = false
  setCollabKeys(false)
}

/** overlay 聚焦 → 主进程屏蔽菜单加速键（Cmd+W/Q 等留给远端）；失焦 / 退出恢复。 */
function setCollabKeys(active: boolean) {
  if (isElectron) (window as any).electronAPI?.browserLive?.setCollabKeys?.(active)
}

function modsOf(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): number {
  return buildModifiers({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, isMac)
}

/** 画布坐标 → 远端视口坐标（sender 内建三级降级：meta → naturalWidth → null 忽略）。 */
function canvasPoint(e: MouseEvent | WheelEvent): { x: number; y: number } | null {
  const canvas = canvasRef.value
  if (!canvas || !sender) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const dx = e.clientX - rect.left
  const dy = e.clientY - rect.top
  // 画布 letterbox 黑边（容器与帧宽高比不一致时 flex 居中留边）：出界忽略而非钳 0——
  // 钳 0 会变成远端视口左上角的真实点击（评审 P1-3）
  if (dx < 0 || dx > rect.width || dy < 0 || dy > rect.height) return null
  return sender.map(dx, dy, rect.width, rect.height)
}

function updateGhost(e: PointerEvent) {
  const canvas = canvasRef.value
  const body = liveBodyRef.value
  if (!canvas || !body) return
  const rect = canvas.getBoundingClientRect()
  const dx = e.clientX - rect.left
  const dy = e.clientY - rect.top
  if (dx < 0 || dx > rect.width || dy < 0 || dy > rect.height) {
    ghostPos.value = null
    return
  }
  const bodyRect = body.getBoundingClientRect()
  ghostPos.value = { x: e.clientX - bodyRect.left, y: e.clientY - bodyRect.top }
}

const CLICK_WINDOW_MS = 500
const clickStats = new Map<string, { at: number; count: number }>()
/** 最近一次 press 的 clickCount：release 携带同值，远端才能合成 detail=2 的 dblclick（评审 P2-2） */
const lastClickCount = new Map<string, number>()
function clickCountOf(button: string): number {
  const now = Date.now()
  const s = clickStats.get(button)
  const count = s && now - s.at <= CLICK_WINDOW_MS ? Math.min(s.count + 1, 3) : 1
  clickStats.set(button, { at: now, count })
  return count
}
function buttonOf(b: number): 'left' | 'right' | 'middle' {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'
}

function pushMousePress(e: PointerEvent, type: 'mousePressed' | 'mouseReleased', fallback?: { x: number; y: number } | null) {
  if (!sender) return
  const p = canvasPoint(e) ?? fallback ?? null
  if (!p) return
  lastMapped = { x: Math.round(p.x), y: Math.round(p.y) }
  const button = buttonOf(e.button)
  let clickCount = 1
  if (type === 'mousePressed') {
    clickCount = clickCountOf(button)
    lastClickCount.set(button, clickCount)
  } else {
    clickCount = lastClickCount.get(button) ?? 1
  }
  const ev: BrowserInputEvent = { type, x: lastMapped.x, y: lastMapped.y, button, clickCount }
  const mods = modsOf(e)
  if (mods) ev.modifiers = mods
  sender.push(ev)
}

function onOverlayPointerDown(e: PointerEvent) {
  if (!sender) return
  e.preventDefault()
  // preventDefault 会阻断 mousedown 的默认聚焦：显式 focus，点回画布后键盘才能重新接管
  overlayRef.value?.focus()
  // 捕获 pointer：拖拽出画布后的 pointerup / pointercancel 仍回本层（否则远端按压卡死）
  overlayRef.value?.setPointerCapture?.(e.pointerId)
  pushMousePress(e, 'mousePressed')
}

function onOverlayPointerUp(e: PointerEvent) {
  if (!sender) return
  e.preventDefault()
  // 释放点可能落在画布外（拖拽出界）：用最后已知映射位置补 mouseReleased
  pushMousePress(e, 'mouseReleased', lastMapped)
}

function onOverlayPointerCancel(e: PointerEvent) {
  if (!sender) return
  pushMousePress(e, 'mouseReleased', lastMapped)
}

function onOverlayPointerMove(e: PointerEvent) {
  if (!sender) return
  updateGhost(e)
  const p = canvasPoint(e)
  if (!p) return
  lastMapped = { x: Math.round(p.x), y: Math.round(p.y) }
  sender.push({ type: 'mouseMoved', x: lastMapped.x, y: lastMapped.y }, { dragging: e.buttons !== 0 })
}

function onOverlayWheel(e: WheelEvent) {
  if (!sender) return
  const p = canvasPoint(e)
  if (!p) return
  const ev: BrowserInputEvent = { type: 'mouseWheel', x: Math.round(p.x), y: Math.round(p.y), deltaX: e.deltaX, deltaY: e.deltaY }
  const mods = modsOf(e)
  if (mods) ev.modifiers = mods // Ctrl+滚轮（触控板捏合缩放）依赖 D10 的 modifiers
  sender.push(ev)
}

// 键盘（keydown→rawKeyDown、keypress→char，对齐浏览器原生事件流；macOS Cmd 翻译为远端 Ctrl）
function onOverlayKeyDown(e: KeyboardEvent) {
  if (!sender) return
  e.preventDefault()
  if (e.key === 'Escape') { exitCollab(); return } // Esc = 退出协作（键盘逃逸口）
  if (composing || e.isComposing) return
  const k = translateKeyEvent(e.key, e.code, e.keyCode, isMac)
  const ev: BrowserInputEvent = { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode }
  const mods = modsOf(e)
  if (mods) ev.modifiers = mods
  sender.push(ev)
}

function onOverlayKeyUp(e: KeyboardEvent) {
  if (!sender) return
  if (composing || e.isComposing) return
  const k = translateKeyEvent(e.key, e.code, e.keyCode, isMac)
  const ev: BrowserInputEvent = { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode }
  const mods = modsOf(e)
  if (mods) ev.modifiers = mods
  sender.push(ev)
}

function onOverlayKeyPress(e: KeyboardEvent) {
  if (!sender) return
  e.preventDefault()
  if (composing || e.isComposing) return
  // keypress 只在可打印键触发；单字符走 char（Space/符号都覆盖，Enter 等功能键走 rawKeyDown）
  if (e.key.length === 1) sender.push({ type: 'char', text: e.key })
}

// IME：合成期间暂停转发，compositionend 整段 insertText（D4——逐键会打碎拼音）
function onCompositionStart() {
  composing = true
}

function onOverlayCompositionEnd(e: CompositionEvent) {
  composing = false
  if (sender && e.data) sender.push({ type: 'insertText', text: e.data })
}

function onOverlayFocus() {
  setCollabKeys(true)
}

function onOverlayBlur() {
  setCollabKeys(false)
  sender?.releaseAllKeys() // 失焦即停止转发路径：补 keyUp 防远端卡键
}

function onVisibilityChange() {
  if (document.hidden && collabActive.value) {
    setCollabKeys(false)
    sender?.releaseAllKeys()
  }
}

// 协作失效路径：直播结束 / 切回放 / 切会话（sender 绑定创建时的 sid，画布却跟随
// activeSessionId 每帧漂移——不退出会把输入注入到「用户正在看的另一场直播」，评审 P1-1）
watch(() => [state.value?.isLive, viewMode.value, numericSessionId.value] as const, ([isLive, mode], prev) => {
  if (!collabActive.value) return
  if (isLive !== true || mode !== 'live' || prev[2] !== numericSessionId.value) exitCollab()
})

// 帧到达：刷新映射元数据（meta 帧级缺失沿用上一个，降级 fallback 用当前 JPEG 尺寸）
watch(() => state.value?.frame, () => {
  if (sender) sender.updateFrameMeta(state.value?.frameMeta ?? null, lastImageSize.value)
})

// 帧延迟提示（§7.1）：控制开启且最近帧龄 >1.5s
watch(collabActive, (active) => {
  if (active) {
    staleTimer = setInterval(() => {
      frameStale.value = Date.now() - (state.value?.lastFrameAt ?? 0) > 1500
    }, 1000)
  } else if (staleTimer != null) {
    clearInterval(staleTimer)
    staleTimer = null
    frameStale.value = false
  }
})

function onStop() {
  store.stopBrowser(numericSessionId.value)
}

function onRestore() {
  store.restorePip()
}

function onHidePip() {
  store.hidePip()
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
})

// KeepAlive 停用（程序化切走 center Tab）：DOM 摘除不派发 blur、也不触发卸载——
// 必须显式退出协作，否则菜单加速键屏蔽粘滞 + 远端卡键（评审 P1-2）
onDeactivated(() => {
  exitCollab()
})

onActivated(() => {
  // 停用期间帧已推进：补画当前帧（与 exitReplay 的补画同因——canvas 随 viewMode 重挂）
  void nextTick(() => drawFrame(state.value?.frame))
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  exitCollab() // 组件卸载也是停止转发路径：冲刷 + 全量 keyUp 释放
  if (staleTimer != null) {
    clearInterval(staleTimer)
    staleTimer = null
  }
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
.agent-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #2c2c36;
  color: #d9a441;
  flex: none;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.icon-btn-wrap {
  display: inline-flex;
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
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.icon-btn.collab-on {
  background: #2c2c36;
  color: #4da3ff;
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
/* 协作交互层：真实光标隐藏（ghost cursor 接管跟手感），全量 preventDefault 抑制本地行为 */
.input-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  outline: none;
  cursor: none;
  user-select: none;
  -webkit-user-select: none;
}
.ghost-cursor {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(77, 163, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.75);
  pointer-events: none;
  z-index: 2;
}
.frame-stale-hint {
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 2;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 8px;
  background: rgba(26, 26, 33, 0.92);
  border: 1px solid #4a3a20;
  color: #d9a441;
  pointer-events: none;
}
.live-placeholder {
  padding: 12px;
  text-align: center;
  color: #6e6e80;
}
.replay-entry {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 2;
  padding: 5px 14px;
  font-size: 12px;
  border: 1px solid #2c2c36;
  border-radius: 8px;
  background: rgba(26, 26, 33, 0.9);
  color: #c8c8d4;
  cursor: pointer;
}
.replay-entry:hover {
  border-color: #4da3ff;
  color: #e6e6eb;
}
.live-resume-banner {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 12px;
  background: rgba(26, 26, 33, 0.92);
  border: 1px solid #4a3a20;
  border-radius: 8px;
  font-size: 11px;
  color: #d9a441;
  z-index: 2;
}
.resume-btn {
  border: none;
  background: transparent;
  color: #4da3ff;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
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
