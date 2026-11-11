<template>
  <el-dialog
    v-model="isOpen"
    class="command-palette-dialog"
    width="min(560px, calc(100vw - 32px))"
    align-center
    append-to-body
    modal-class="command-palette-overlay"
    :show-close="false"
    :lock-scroll="true"
    @opened="onOpened"
    @closed="onClosed"
  >
    <template #header>
      <div class="palette-header">
        <div>
          <h2>命令面板</h2>
          <p class="palette-hints"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭</p>
        </div>
        <button class="palette-close" type="button" aria-label="关闭命令面板" @click="isOpen = false">
          <el-icon :size="18"><Close /></el-icon>
        </button>
      </div>
    </template>
    <div class="palette-panel">
      <el-input
        ref="inputRef"
        v-model="keyword"
        class="palette-input"
        size="large"
        placeholder="输入命令或关键词"
        clearable
        :maxlength="100"
        @keydown="onInputKeydown"
      >
        <template #prefix><el-icon :size="18"><Search /></el-icon></template>
      </el-input>
      <div v-if="filtered.length === 0" class="palette-empty">无匹配命令</div>
      <div v-else ref="listRef" class="palette-list" role="listbox" aria-label="命令列表">
        <template v-for="groupId in COMMAND_GROUP_ORDER" :key="groupId">
          <template v-if="grouped[groupId].length > 0">
            <div class="palette-group-title">{{ COMMAND_GROUP_LABELS[groupId] }}</div>
            <button
              v-for="entry in grouped[groupId]"
              :key="entry.item.id"
              type="button"
              class="palette-item"
              role="option"
              :aria-selected="entry.index === activeIndex"
              :class="{ active: entry.index === activeIndex, disabled: entry.item.enabled === false }"
              :disabled="entry.item.enabled === false"
              @mouseenter="onItemHover(entry)"
              @click="runItem(entry.item)"
            >
              <span class="palette-item-title">{{ entry.item.title }}</span>
              <img
                v-if="entry.item.avatarUrl"
                class="palette-item-avatar"
                :src="entry.item.avatarUrl"
                alt=""
                @error="onAvatarError"
              >
              <span v-if="entry.item.active" class="palette-item-check">✓</span>
            </button>
          </template>
        </template>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Close, Search } from '@element-plus/icons-vue'
import { useAgentStore } from '../../stores/agent'
import {
  buildCommands,
  filterCommands,
  COMMAND_GROUP_LABELS,
  COMMAND_GROUP_ORDER,
  type CommandGroupId,
  type CommandHostActions,
  type CommandItem
} from '../../composables/useCommandRegistry'

const props = defineProps<{ host: CommandHostActions }>()

const inputRef = ref()
const listRef = ref<HTMLDivElement>()
const isOpen = ref(false)
const keyword = ref('')
const activeIndex = ref(0)
const items = ref<CommandItem[]>([])
// 面板内按过 `?`：true 时快捷键组参与本帧列表；关闭面板复位（评审拍板：`?` 仅面板内生效）
const showShortcuts = ref(false)
const route = useRoute()
// 打开面板前的焦点元素：关闭时还原（与 0.0.471 searchJumpFocus 同口径的开合闭环）
let previouslyFocused: HTMLElement | null = null

const filtered = computed(() => filterCommands(items.value, keyword.value))

/** 过滤结果按分组的视图；entry.index 是该条在 filtered 中的扁平下标（与 activeIndex 配套）。 */
const grouped = computed(() => {
  const map = {} as Record<CommandGroupId, Array<{ item: CommandItem; index: number }>>
  for (const groupId of COMMAND_GROUP_ORDER) map[groupId] = []
  filtered.value.forEach((item, index) => {
    map[item.group].push({ item, index })
  })
  // Agent 组渲染层截断（批次 29 提案 3 拍板）：无关键词时只展示前 6 条 + 置灰筛选提示。
  // hint 的 index 取 -1——不与真实 filtered 下标碰撞，aria-selected 永不误亮；
  // hover / click / 键盘移动已被 enabled 守卫拦截，无需参与选择语义。
  const agents = map.agents
  if (!keyword.value.trim() && agents.length > AGENT_GROUP_VISIBLE_MAX) {
    map.agents = [
      ...agents.slice(0, AGENT_GROUP_VISIBLE_MAX),
      {
        item: { id: 'agent:hint', group: 'agents', title: '输入名称筛选更多 Agent', enabled: false, run: () => undefined },
        index: -1
      }
    ]
  }
  return map
})

watch(filtered, () => {
  const len = filtered.value.length
  if (len === 0) {
    activeIndex.value = 0
    return
  }
  const current = filtered.value[activeIndex.value]
  if (!current || current.enabled === false) {
    const firstEnabled = filtered.value.findIndex((item) => item.enabled !== false)
    activeIndex.value = firstEnabled >= 0 ? firstEnabled : 0
  }
})

watch(activeIndex, async () => {
  await nextTick()
  const active = listRef.value?.querySelector<HTMLElement>('.palette-item.active')
  active?.scrollIntoView({ block: 'nearest' })
})

/** Agent 组无关键词时的可见上限（拍板口径：前 6 条 + 筛选提示；有关键词走既有搜索不截断）。 */
const AGENT_GROUP_VISIBLE_MAX = 6

/** 按当次快照重建命令清单（面板打开 / `?` 唤出 / Agent 拉取完成时调用）。 */
function rebuildItems() {
  const agentStore = useAgentStore()
  items.value = buildCommands(props.host, {
    agents: agentStore.agents,
    inSessionRoute: route.name === 'Task',
    showShortcuts: showShortcuts.value
  })
}

function open() {
  showShortcuts.value = false
  keyword.value = ''
  activeIndex.value = 0
  const agentStore = useAgentStore()
  if (!agentStore.agents.length) {
    // 首开空窗兜底：登录后首次打开是唯一 store 未加载场景，拉取完成时面板若仍开着就重建（不加 loading 态）
    void agentStore.fetchAgents().then(() => {
      if (isOpen.value) rebuildItems()
    })
  }
  rebuildItems()
  previouslyFocused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null
  isOpen.value = true
}

function close() {
  isOpen.value = false
}

function toggle() {
  if (isOpen.value) close()
  else open()
}

function onOpened() {
  nextTick(() => inputRef.value?.focus())
}

function onClosed() {
  keyword.value = ''
  activeIndex.value = 0
  // 命令可能已把焦点交给别的浮层（搜索浮窗 / 速查表）：焦点已离开面板时不再抢回
  const current = document.activeElement
  if (current === null || current === document.body) {
    previouslyFocused?.focus()
  }
  previouslyFocused = null
}

function onItemHover(entry: { item: CommandItem; index: number }) {
  if (entry.item.enabled === false) return
  activeIndex.value = entry.index
}

/** 头像加载失败隐藏自身（纯装饰图，alt 为空，名称已承载语义）。 */
function onAvatarError(e: Event) {
  ;(e.target as HTMLElement).style.display = 'none'
}

/** ArrowUp/Down 在过滤结果上循环移位，跳过置灰项；全部置灰时不动。 */
function moveSelection(dir: 1 | -1) {
  const list = filtered.value
  const len = list.length
  if (len === 0) return
  if (!list.some((item) => item.enabled !== false)) return
  let idx = activeIndex.value
  do {
    idx = (idx + dir + len) % len
  } while (list[idx].enabled === false)
  activeIndex.value = idx
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filtered.value[activeIndex.value]
    if (item) runItem(item)
  } else if (e.key === '?' && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // 面板内速查组（评审拍板 `?` 仅面板内生效）：不落入输入框，追加快捷键组键入即过滤；
    // isComposing 防中文 IME 组合态吞字符（全局键无此问题——input 整体被 isTypingTarget 排除）；
    // 修饰键排除与全局 `?` 分支口径对齐（Ctrl+Shift+/ 等组合键不触发）
    e.preventDefault()
    showShortcuts.value = true
    rebuildItems()
  } else if (e.key === 'Escape') {
    isOpen.value = false
  }
}

/** 执行语义（技术方案步骤 2）：先关面板再执行命令。 */
function runItem(item: CommandItem) {
  if (item.enabled === false) return
  isOpen.value = false
  item.run()
}

defineExpose({ toggle, open, close })
</script>

<style scoped>
.palette-panel {
  min-width: 0;
}

.palette-input {
  width: 100%;
}

.palette-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}

.palette-list {
  margin-top: 10px;
  max-height: min(420px, calc(100vh - 300px));
  overflow-y: auto;
  border: 1px solid var(--aw-border);
  border-radius: 12px;
  padding: 6px;
}

.palette-group-title {
  padding: 8px 8px 4px;
  color: var(--aw-ink-muted-48);
  font-size: 12px;
}

.palette-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  text-align: left;
  color: var(--aw-ink);
  cursor: pointer;
}

.palette-item.active,
.palette-item:hover {
  background: var(--aw-surface-hover);
}

.palette-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.palette-item-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Agent 组条目右侧头像：装饰图（alt 空串），加载失败由 onAvatarError 隐藏 */
.palette-item-avatar {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}

.palette-item-check {
  flex-shrink: 0;
  color: var(--aw-primary);
  font-size: 12px;
}
</style>

<style>
/* ElDialog 内容 teleport 到 body，需用非 scoped 样式（照 SessionSearchPopover 范式） */
.command-palette-overlay.el-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
}

.command-palette-overlay .el-overlay-dialog {
  position: static;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 24px 16px;
  overflow: auto;
}

.command-palette-dialog.el-dialog {
  max-height: min(640px, calc(100vh - 48px));
  margin: 0;
  padding: 0;
  overflow: hidden;
  border-radius: 16px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.22);
}

.command-palette-dialog .el-dialog__header {
  margin: 0;
  padding: 20px 20px 12px;
}

.command-palette-dialog .el-dialog__body {
  padding: 0 20px 20px;
}

.command-palette-dialog .palette-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.command-palette-dialog .palette-header h2 {
  margin: 0;
  color: var(--aw-ink);
  font-size: 18px;
  line-height: 1.4;
}

.command-palette-dialog .palette-hints {
  margin: 4px 0 0;
  color: var(--aw-ink-muted-48);
  font-size: 12px;
}

.command-palette-dialog .palette-hints kbd,
.command-palette-dialog kbd {
  min-width: 20px;
  padding: 1px 5px;
  border: 1px solid var(--aw-border);
  border-radius: 5px;
  color: var(--aw-ink-muted-80);
  background: var(--aw-surface-hover);
  font: inherit;
  text-align: center;
}

.command-palette-dialog .palette-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: var(--aw-ink-muted-48);
  background: transparent;
  cursor: pointer;
  position: relative;
}

/* 触屏命中泡 44px（照 SessionSearchPopover .search-close 既有模式；仅 pointer: coarse 生效） */
@media (pointer: coarse) {
  .command-palette-dialog .palette-close::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }
}

.command-palette-dialog .palette-close:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}
</style>
