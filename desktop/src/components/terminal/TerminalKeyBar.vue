<template>
  <div
    class="terminal-keybar"
    @pointerdown.prevent
    @contextmenu.prevent
  >
    <div v-for="(row, rowIndex) in rows" :key="rowIndex" class="terminal-keybar-row">
      <button
        v-for="key in row"
        :key="key.label"
        type="button"
        class="terminal-keybar-btn"
        :class="{
          active: isModifierActive(key),
          locked: isModifierLocked(key),
        }"
        :aria-label="key.ariaLabel ?? key.label"
        :aria-pressed="key.action === 'ctrl' ? ctrlState !== 'off' : key.action === 'alt' ? altState !== 'off' : undefined"
        @pointerdown="startRepeat(key, $event)"
        @pointerup="stopRepeat"
        @pointercancel="stopRepeat"
        @pointerleave="stopRepeat"
        @click="handleClick(key)"
      >{{ key.label }}</button>
    </div>

    <div v-if="moreOpen" class="terminal-keybar-backdrop" @click="moreOpen = false" />
    <div v-if="moreOpen" class="terminal-keybar-more" role="menu" aria-label="更多按键">
      <button
        v-for="key in moreKeys"
        :key="key.label"
        type="button"
        class="terminal-keybar-btn terminal-keybar-more-btn"
        :aria-label="key.ariaLabel ?? key.label"
        @pointerdown="startRepeat(key, $event)"
        @pointerup="stopRepeat"
        @pointercancel="stopRepeat"
        @pointerleave="stopRepeat"
        @click="handleClick(key)"
      >{{ key.label }}</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" @click="handleMoreAction('select-text')">选择文本</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" @click="handleMoreAction('search')">搜索</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" aria-label="缩小字号" @click="handleMoreAction('font-down')">A−</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" aria-label="放大字号" @click="handleMoreAction('font-up')">A+</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" @click="handleMoreAction('maximize')">最大化 / 还原</button>
      <button type="button" class="terminal-keybar-btn terminal-keybar-more-btn" @click="handleMoreAction('hide-keybar')">收起按键条</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import {
  KEY_BAR_MORE,
  KEY_BAR_ROW1,
  KEY_BAR_ROW2,
  isRepeatable,
  type KeyBarAction,
  type KeyId,
  type TerminalKeyDef,
} from '../../utils/terminal-keys'

const props = defineProps<{
  ctrlState: 'off' | 'once' | 'locked'
  altState: 'off' | 'once' | 'locked'
}>()

const emit = defineEmits<{
  /** 普通按键：父组件按当前 DECCKM / 修饰键编码后走 sendRaw。 */
  key: [id: KeyId]
  /** 动作键：粘贴、软键盘开关、复制层、搜索、字号、最大化、收起、Ctrl / Alt 粘滞。 */
  action: [action: KeyBarAction | 'ctrl' | 'alt']
}>()

const rows = [KEY_BAR_ROW1, KEY_BAR_ROW2]
const moreKeys = KEY_BAR_MORE
const moreOpen = ref(false)

const REPEAT_DELAY_MS = 400
const REPEAT_INTERVAL_MS = 50
let repeatDelayTimer: ReturnType<typeof setTimeout> | null = null
let repeatIntervalTimer: ReturnType<typeof setInterval> | null = null
/** 连发过就吞掉随后的 click，避免松手时多发一次。 */
let repeatFired = false

function isModifierActive(key: TerminalKeyDef): boolean {
  return (key.action === 'ctrl' && props.ctrlState !== 'off') || (key.action === 'alt' && props.altState !== 'off')
}

function isModifierLocked(key: TerminalKeyDef): boolean {
  return (key.action === 'ctrl' && props.ctrlState === 'locked') || (key.action === 'alt' && props.altState === 'locked')
}

function clearRepeatTimers(): void {
  if (repeatDelayTimer != null) {
    clearTimeout(repeatDelayTimer)
    repeatDelayTimer = null
  }
  if (repeatIntervalTimer != null) {
    clearInterval(repeatIntervalTimer)
    repeatIntervalTimer = null
  }
}

// 收起按键条 / 关闭面板时组件卸载，必须停掉长按连发，避免定时器继续向终端发键
onUnmounted(clearRepeatTimers)

function stopRepeat(): void {
  clearRepeatTimers()
}

function startRepeat(key: TerminalKeyDef, event: Event): void {
  // 阻止长按选中文本；根节点的 pointerdown.prevent 已处理焦点，这里只负责连发
  event.preventDefault()
  stopRepeat()
  repeatFired = false
  if (!key.id || !isRepeatable(key.id)) return
  const keyId = key.id
  repeatDelayTimer = setTimeout(() => {
    repeatFired = true
    repeatIntervalTimer = setInterval(() => emit('key', keyId), REPEAT_INTERVAL_MS)
  }, REPEAT_DELAY_MS)
}

function handleClick(key: TerminalKeyDef): void {
  if (repeatFired) {
    repeatFired = false
    return
  }
  if (key.id) {
    emit('key', key.id)
    return
  }
  if (key.action === 'more') {
    moreOpen.value = !moreOpen.value
    return
  }
  if (key.action === 'ctrl' || key.action === 'alt') {
    emit('action', key.action)
    return
  }
  if (key.action === 'keyboard' || key.action === 'paste') {
    emit('action', key.action)
  }
}

function handleMoreAction(action: Exclude<KeyBarAction, 'keyboard' | 'paste'>): void {
  // 字号调整保留弹层，方便连续点 A− / A+；其余动作执行完就收起
  if (action !== 'font-down' && action !== 'font-up') moreOpen.value = false
  emit('action', action)
}
</script>

<style scoped>
.terminal-keybar {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 8px;
  background: var(--aw-terminal-header-bg);
  border-top: 1px solid var(--aw-divider-soft);
  user-select: none;
  -webkit-user-select: none;
}

.terminal-keybar-row {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.terminal-keybar-btn {
  flex: 1 1 0;
  min-width: 0;
  height: 36px;
  padding: 0 2px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}

.terminal-keybar-btn:active {
  background: var(--aw-divider-soft);
}

.terminal-keybar-btn.active {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
}

.terminal-keybar-btn.locked {
  background: var(--aw-divider-soft);
  font-weight: 600;
}

.terminal-keybar-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.terminal-keybar-more {
  position: absolute;
  z-index: 30;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 4px);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  background: var(--aw-canvas);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
}

.terminal-keybar-more-btn {
  height: 34px;
  flex: none;
  font-size: 11px;
}

@media (max-width: 360px) {
  .terminal-keybar-btn {
    font-size: 10px;
  }
}
</style>