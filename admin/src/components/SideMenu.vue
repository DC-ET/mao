<template>
  <div class="side-menu-wrap" :class="{ 'is-collapsed': collapsed }">
    <div v-if="showLogo" class="logo" @click="goHome">
      <img class="logo-img" :src="logoSrc" alt="" />
      <div v-if="!collapsed" class="logo-text">
        <strong>Mao</strong>
        <span>管理后台</span>
      </div>
    </div>

    <div v-if="!collapsed" class="menu-search">
      <el-icon class="menu-search-icon"><Search /></el-icon>
      <input
        ref="searchInputRef"
        v-model="query"
        class="menu-search-input"
        type="text"
        placeholder="搜索菜单"
        aria-label="搜索菜单"
        autocomplete="off"
        @keydown.down.prevent="moveCursor(1)"
        @keydown.up.prevent="moveCursor(-1)"
        @keydown.enter.prevent="confirmCursor"
        @keydown.esc.prevent="onSearchEsc"
      />
      <kbd v-if="!query" class="menu-search-kbd">{{ kbdHint }}</kbd>
      <el-icon
        v-else
        class="menu-search-clear"
        role="button"
        aria-label="清空搜索"
        @click="clearQuery"
      ><CircleCloseFilled /></el-icon>
    </div>
    <button
      v-else
      type="button"
      class="menu-search-collapsed"
      title="展开侧栏搜索菜单"
      aria-label="展开侧栏搜索菜单"
      @click="expandForSearch"
    >
      <el-icon><Search /></el-icon>
    </button>

    <nav ref="navRef" class="sidebar-menu" aria-label="主导航">
      <template v-for="group in displayedGroups" :key="group.id">
        <div v-if="collapsed" class="group-divider" role="separator" aria-hidden="true" />
        <div v-else-if="!group.label" class="group-head-spacer" aria-hidden="true" />
        <button
          v-else-if="!searching"
          type="button"
          class="group-head"
          :aria-expanded="!isFolded(group.id)"
          @click="toggleGroup(group.id)"
        >
          <span class="group-label">{{ group.label }}</span>
          <span class="group-meta">
            <span class="group-count">{{ group.items.length }}</span>
            <el-icon class="group-chevron" :class="{ 'is-folded': isFolded(group.id) }"><ArrowDown /></el-icon>
          </span>
        </button>
        <div v-else class="group-head is-static" aria-hidden="true">
          <span class="group-label">{{ group.label }}</span>
        </div>

        <div
          class="group-body"
          :class="{ 'is-folded': !collapsed && !!group.label && !searching && isFolded(group.id) }"
        >
          <div class="group-body-inner">
            <el-tooltip
              v-for="item in group.items"
              :key="item.index"
              :content="item.label"
              placement="right"
              :disabled="!collapsed"
              :show-after="250"
            >
              <router-link
                :to="item.index"
                class="menu-item"
                :class="{
                  'is-active': activeMenu === item.index,
                  'is-cursor': searching && flatItems[cursorIndex]?.index === item.index
                }"
                @click="onItemClick"
              >
                <el-icon class="menu-item-icon"><component :is="item.icon" /></el-icon>
                <span v-if="!collapsed" class="menu-label">
                  <template v-if="searching">
                    <span
                      v-for="(seg, segIdx) in highlightSegments(item.label, query)"
                      :key="segIdx"
                      :class="{ 'menu-hit': seg.hit }"
                    >{{ seg.text }}</span>
                  </template>
                  <template v-else>{{ item.label }}</template>
                </span>
              </router-link>
            </el-tooltip>
          </div>
        </div>
      </template>

      <div v-if="searching && flatItems.length === 0" class="menu-empty">
        <el-icon class="menu-empty-icon"><Search /></el-icon>
        <p>未找到「{{ query.trim() }}」相关菜单</p>
        <button type="button" class="menu-empty-clear" @click="clearQuery">清空搜索</button>
      </div>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, CircleCloseFilled, Search } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'
import { useMenuStore } from '../stores/menu'
import { pickHomePath } from '../utils/home'
import {
  applyMenuVisibility,
  filterMenuGroups,
  flattenMenuItems,
  highlightSegments,
  menuGroupIdByPath,
  menuGroups,
  type MenuItemDef
} from '../utils/menuNav'

// Vue 3.5 响应式 props 解构：模板可直接用 showLogo / collapsed，脚本中读取同样是响应式的
const { showLogo = true, collapsed = false } = defineProps<{
  showLogo?: boolean
  collapsed?: boolean
}>()

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'expand'): void
}>()

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const menuStore = useMenuStore()

const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

// ── 搜索 ────────────────────────────────────────────────────────
const query = ref('')
const searching = computed(() => query.value.trim().length > 0)
const searchInputRef = ref<HTMLInputElement | null>(null)
const navRef = ref<HTMLElement | null>(null)
const cursorIndex = ref(0)

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
const kbdHint = isMac ? '⌘K' : 'Ctrl K'

function clearQuery() {
  query.value = ''
}

function onSearchEsc() {
  if (query.value) {
    clearQuery()
    return
  }
  searchInputRef.value?.blur()
}

async function moveCursor(delta: number) {
  const len = flatItems.value.length
  if (!len) return
  cursorIndex.value = (cursorIndex.value + delta + len) % len
  await nextTick()
  navRef.value?.querySelector('.menu-item.is-cursor')?.scrollIntoView({ block: 'nearest' })
}

function confirmCursor() {
  if (!searching.value) return
  const item = flatItems.value[cursorIndex.value]
  if (!item) return
  router.push(item.index)
  clearQuery()
  searchInputRef.value?.blur()
  emit('select')
}

watch(query, () => {
  cursorIndex.value = 0
})

// ── 分组折叠（持久化） ──────────────────────────────────────────
// 注意：须先于 flatItems 等读取 isFolded 的 computed 声明，否则 watch 求值时触发 TDZ
const FOLDED_KEY = 'admin-menu-folded-groups'

function loadFoldedIds(): string[] {
  try {
    const raw = localStorage.getItem(FOLDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

const foldedIds = ref<string[]>(loadFoldedIds())

watch(foldedIds, (ids) => {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify(ids))
  } catch {
    // 存储不可用（隐私模式等）时仅放弃持久化
  }
})

function isFolded(id: string) {
  return foldedIds.value.includes(id)
}

function toggleGroup(id: string) {
  foldedIds.value = isFolded(id)
    ? foldedIds.value.filter(v => v !== id)
    : [...foldedIds.value, id]
}

// ── 菜单分组与权限 ──────────────────────────────────────────────
function canSee(item: MenuItemDef) {
  return !item.permission || authStore.hasPermission(item.permission)
}

// 权限过滤之上再叠加部署级可见性过滤（applyMenuVisibility 内部已剔除变空的分组）：
// 侧栏 / 抽屉 / ⌘K 搜索 / 键盘导航全部从 visibleGroups 派生，一处过滤全端生效。
const visibleGroups = computed(() =>
  applyMenuVisibility(
    menuGroups
      .map(group => ({ ...group, items: group.items.filter(canSee) }))
      .filter(group => group.items.length > 0),
    menuStore.hidden
  )
)

const displayedGroups = computed(() =>
  searching.value ? filterMenuGroups(visibleGroups.value, query.value) : visibleGroups.value
)

// 键盘选择只覆盖当前可见项：搜索时全部分组展开；未搜索时折叠分组的项不可选
const flatItems = computed(() =>
  flattenMenuItems(
    searching.value
      ? displayedGroups.value
      : displayedGroups.value.filter(group => !group.label || !isFolded(group.id))
  )
)

watch(flatItems, (items) => {
  if (cursorIndex.value >= items.length) cursorIndex.value = 0
})

// 激活路由所在分组被折叠时自动展开，保证高亮项始终可见（含顶栏 Tab 切页场景）
const activeMenu = computed(() => '/' + (route.path.split('/')[1] || ''))

watch(
  activeMenu,
  (seg) => {
    const gid = menuGroupIdByPath(menuGroups, seg)
    if (gid && isFolded(gid)) {
      foldedIds.value = foldedIds.value.filter(v => v !== gid)
    }
  },
  { immediate: true }
)

// ── 折叠窄栏的搜索入口：展开侧栏并聚焦 ─────────────────────────
const focusOnExpand = ref(false)

function expandForSearch() {
  focusOnExpand.value = true
  emit('expand')
}

watch(
  () => collapsed,
  (val) => {
    if (!val && focusOnExpand.value) {
      focusOnExpand.value = false
      nextTick(() => searchInputRef.value?.focus())
    }
  }
)

// 全局快捷键 ⌘K / Ctrl+K：聚焦菜单搜索（折叠态先展开侧栏）
function onGlobalKeydown(e: KeyboardEvent) {
  if (!((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K'))) return
  e.preventDefault()
  if (collapsed) {
    expandForSearch()
    return
  }
  const el = searchInputRef.value
  // 抽屉里的隐藏实例不参与聚焦
  if (!el || el.offsetParent === null) return
  el.focus()
  el.select()
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// ── 导航 ────────────────────────────────────────────────────────
function goHome() {
  const path = pickHomePath(
    (permission) => authStore.hasPermission(permission),
    (index) => menuStore.isHidden(index)
  )
  router.push(path === '/forbidden' ? '/login' : path)
  emit('select')
}

function onItemClick() {
  emit('select')
}
</script>

<style scoped>
.side-menu-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mao-surface);
}

.logo {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  color: var(--mao-ink);
  cursor: pointer;
  flex-shrink: 0;
}

.is-collapsed .logo {
  justify-content: center;
  padding: 0;
}

.logo-img {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.logo-text strong {
  font-size: 15px;
  font-weight: 600;
}

.logo-text span {
  font-size: 11px;
  color: var(--mao-muted);
}

/* ── 搜索 ── */
.menu-search {
  position: relative;
  display: flex;
  align-items: center;
  margin: 2px 12px 8px;
  flex-shrink: 0;
}

.menu-search-icon {
  position: absolute;
  left: 9px;
  font-size: 14px;
  color: var(--mao-muted);
  pointer-events: none;
}

.menu-search-input {
  width: 100%;
  height: 32px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--mao-canvas);
  padding: 0 40px 0 29px;
  font-family: inherit;
  font-size: 13px;
  color: var(--mao-ink);
  outline: none;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.menu-search-input::placeholder {
  color: var(--mao-muted);
}

.menu-search-input:hover {
  border-color: var(--mao-border);
}

.menu-search-input:focus {
  background: var(--mao-surface);
  border-color: var(--mao-accent);
  box-shadow: 0 0 0 3px var(--mao-accent-ring);
}

.menu-search-kbd {
  position: absolute;
  right: 8px;
  padding: 1px 5px;
  border: 1px solid var(--mao-border);
  border-radius: 4px;
  background: var(--mao-surface);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.4;
  color: var(--mao-muted);
  pointer-events: none;
}

/* 触屏（移动端抽屉）没有键盘，隐藏快捷键提示 */
@media (hover: none) {
  .menu-search-kbd {
    display: none;
  }
}

.menu-search-clear {
  position: absolute;
  right: 8px;
  font-size: 14px;
  color: var(--mao-muted);
  cursor: pointer;
}

.menu-search-clear:hover {
  color: var(--mao-ink);
}

.menu-search-collapsed {
  width: 36px;
  height: 36px;
  margin: 2px auto 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 16px;
  color: var(--mao-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.menu-search-collapsed:hover {
  background: var(--mao-canvas);
  color: var(--mao-ink);
}

/* ── 导航主体 ── */
.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 8px 12px;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.sidebar-menu::-webkit-scrollbar {
  width: 6px;
}

.sidebar-menu::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}

.sidebar-menu:hover {
  scrollbar-color: var(--mao-chip) transparent;
}

.sidebar-menu:hover::-webkit-scrollbar-thumb {
  background: var(--mao-chip);
}

/* ── 分组标题 ── */
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  padding: 14px 12px 6px;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.05em;
  line-height: 1;
  color: var(--mao-muted);
  cursor: pointer;
  border-radius: 6px;
  transition: color 0.12s ease;
}

.group-head:hover {
  color: var(--mao-ink);
}

.group-head.is-static {
  cursor: default;
}

.group-head.is-static:hover {
  color: var(--mao-muted);
}

.group-head-spacer {
  height: 10px;
}

.group-label {
  flex: 1;
  text-align: left;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.group-count {
  font-size: 10px;
  opacity: 0.8;
}

.group-chevron {
  font-size: 12px;
  transition: transform 0.2s ease;
}

.group-chevron.is-folded {
  transform: rotate(-90deg);
}

/* ── 分组折叠动画（grid 0fr→1fr） ── */
.group-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.22s ease;
}

.group-body.is-folded {
  grid-template-rows: 0fr;
}

.group-body-inner {
  overflow: hidden;
  min-height: 0;
}

/* ── 菜单项 ── */
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  margin: 1px 0;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--mao-ink);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  outline: none;
  transition: background 0.12s ease, color 0.12s ease;
}

.menu-item:hover {
  background: var(--mao-canvas);
}

.menu-item:focus-visible {
  box-shadow: 0 0 0 2px var(--mao-accent-ring);
}

.menu-item.is-active {
  background: var(--mao-accent-bg);
  color: var(--mao-accent);
  font-weight: 500;
}

.menu-item.is-cursor:not(.is-active) {
  background: var(--mao-canvas);
}

.menu-item-icon {
  font-size: 16px;
  color: var(--mao-muted);
  flex-shrink: 0;
  transition: color 0.12s ease;
}

.menu-item:hover .menu-item-icon {
  color: var(--mao-ink);
}

.menu-item.is-active .menu-item-icon {
  color: var(--mao-accent);
}

.menu-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-hit {
  color: var(--mao-accent);
  font-weight: 600;
}

/* ── 空态 ── */
.menu-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  text-align: center;
  color: var(--mao-muted);
  font-size: 12px;
}

.menu-empty p {
  margin: 0;
  overflow-wrap: anywhere;
}

.menu-empty-icon {
  font-size: 20px;
  opacity: 0.6;
}

.menu-empty-clear {
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--mao-accent);
  cursor: pointer;
}

.menu-empty-clear:hover {
  text-decoration: underline;
}

/* ── 折叠窄栏 ── */
.is-collapsed .menu-item {
  padding: 0;
  justify-content: center;
  gap: 0;
}

.group-divider {
  height: 1px;
  margin: 8px 12px;
  background: var(--mao-border);
  opacity: 0.6;
}

/* 窄栏首个分隔线与搜索按钮之间的留白重复，隐藏 */
.sidebar-menu .group-divider:first-child {
  display: none;
}
</style>
