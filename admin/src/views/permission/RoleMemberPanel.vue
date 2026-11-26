<template>
  <section class="rm-panel" :class="`rm-panel--${mode}`">
    <header class="rm-head">
      <el-checkbox
        :model-value="pageAllChecked"
        :indeterminate="pageIndeterminate"
        :disabled="users.length === 0"
        :aria-label="`勾选本页全部${title}`"
        @change="onTogglePage"
      />
      <span class="rm-title">{{ title }}</span>
      <span class="rm-count">{{ countText }}</span>
      <span v-if="selected.size > 0" class="rm-selected">
        已选 {{ selected.size }}
        <el-button link type="primary" size="small" @click="selected = new Map()">清空</el-button>
      </span>
    </header>

    <div class="rm-search">
      <el-input
        ref="searchInput"
        v-model="keyword"
        :prefix-icon="Search"
        :placeholder="mode === 'candidates' ? '搜索用户名 / 显示名 / 邮箱' : '在成员中搜索'"
        clearable
        @keyup.enter="flushSearch"
      />
    </div>

    <div v-loading="loading" class="rm-list" role="listbox" :aria-label="title" aria-multiselectable="true">
      <div
        v-for="row in users"
        :key="row.id"
        class="rm-row"
        :class="{ 'is-checked': selected.has(row.id), 'is-flash': flashIds.has(row.id) }"
        role="option"
        :aria-selected="selected.has(row.id)"
        @click="toggleRow(row)"
      >
        <el-checkbox :model-value="selected.has(row.id)" @click.stop @change="toggleRow(row)" />
        <span class="rm-avatar" aria-hidden="true">{{ initial(row) }}</span>
        <div class="rm-info">
          <div class="rm-name">
            <span class="rm-display">{{ row.displayName || row.username }}</span>
            <el-tag v-if="row.status === 0" type="danger" size="small" effect="plain">已禁用</el-tag>
          </div>
          <div class="rm-sub">{{ subline(row) }}</div>
        </div>
        <el-button
          class="rm-quick"
          :type="mode === 'candidates' ? 'primary' : 'danger'"
          size="small"
          plain
          :disabled="busy"
          :title="`${quickLabel} ${row.username}`"
          @click.stop="emit('quick', row)"
        >
          {{ quickLabel }}
        </el-button>
      </div>
      <el-empty v-if="!loading && users.length === 0" :description="emptyText" :image-size="56" />
    </div>

    <footer v-if="total > pageSize" class="rm-foot">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        :pager-count="5"
        small
        background
        @current-change="fetchUsers"
      />
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { api } from '../../api'
import {
  roleMemberListParams,
  togglePageSelection,
  type RoleMemberListMode,
  type RoleMemberUser,
} from './roleMemberQuery'

const props = defineProps<{
  roleId: number
  mode: RoleMemberListMode
  title: string
  busy?: boolean
  /** 刚被移入本栏的用户，短暂高亮便于确认结果。 */
  flashIds: Set<number>
}>()

const emit = defineEmits<{
  (e: 'quick', row: RoleMemberUser): void
  (e: 'loaded', total: number, keyword: string): void
}>()

/** 跨页、跨搜索保留勾选，搜一个勾一个后一次性提交。 */
const selected = defineModel<Map<number, RoleMemberUser>>('selected', { required: true })

const pageSize = 20
const keyword = ref('')
const page = ref(1)
const users = ref<RoleMemberUser[]>([])
const total = ref(0)
const loading = ref(false)
const searchInput = ref<{ focus: () => void } | null>(null)

const quickLabel = computed(() => (props.mode === 'candidates' ? '添加' : '移出'))
const searching = computed(() => keyword.value.trim().length > 0)
const countText = computed(() => (searching.value ? `匹配 ${total.value}` : `${total.value} 人`))
const emptyText = computed(() => {
  if (props.mode === 'candidates') return searching.value ? '没有匹配的未加入用户' : '所有用户都已加入该角色'
  return searching.value ? '成员中没有匹配的用户' : '该角色暂无成员，从左侧添加'
})
const checkedOnPage = computed(() => users.value.filter((u) => selected.value.has(u.id)).length)
const pageAllChecked = computed(() => users.value.length > 0 && checkedOnPage.value === users.value.length)
const pageIndeterminate = computed(() => checkedOnPage.value > 0 && !pageAllChecked.value)

function initial(row: RoleMemberUser): string {
  return (row.displayName || row.username || '?').trim().charAt(0).toUpperCase()
}

function subline(row: RoleMemberUser): string {
  return [row.displayName ? row.username : '', row.email || ''].filter(Boolean).join(' · ')
}

function toggleRow(row: RoleMemberUser) {
  const next = new Map(selected.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.set(row.id, row)
  selected.value = next
}

function onTogglePage(checked: unknown) {
  selected.value = togglePageSelection(selected.value, users.value, Boolean(checked))
}

let fetchSeq = 0
async function fetchUsers() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const params = roleMemberListParams({
      page: page.value,
      size: pageSize,
      keyword: keyword.value,
      mode: props.mode,
      roleId: props.roleId,
    })
    const { data } = await api.get('/users', { params })
    if (seq !== fetchSeq) return
    users.value = data?.records || []
    total.value = data?.total || 0
    // 操作后当前页可能被搬空（例如最后一页全部移走），回退一页重拉
    if (users.value.length === 0 && page.value > 1 && total.value > 0) {
      page.value = Math.max(1, Math.ceil(total.value / pageSize))
      await fetchUsers()
      return
    }
    emit('loaded', total.value, keyword.value.trim())
  } catch { /* 拦截器已提示失败 */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function flushSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  page.value = 1
  fetchUsers()
}

watch(keyword, () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushSearch, 300)
})

watch(() => props.roleId, () => {
  keyword.value = ''
  flushSearch()
}, { immediate: true })

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

defineExpose({
  refresh: fetchUsers,
  focusSearch: () => searchInput.value?.focus(),
})
</script>

<style scoped>
.rm-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--mao-border, #e0e0e0);
  border-radius: 10px;
  background: var(--mao-surface, #fff);
  overflow: hidden;
}

.rm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mao-border, #e0e0e0);
  background: var(--mao-canvas, #f5f5f7);
  min-height: 44px;
  box-sizing: border-box;
}

.rm-title {
  font-weight: 600;
  color: var(--mao-ink, #1d1d1f);
}

.rm-count {
  color: var(--mao-muted, #6e6e73);
  font-size: 12px;
}

.rm-selected {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--mao-accent, #0066cc);
}

.rm-search {
  padding: 10px 12px 6px;
}

.rm-list {
  height: 360px;
  overflow-y: auto;
  padding: 4px 6px 6px;
}

.rm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.rm-row:hover {
  background: var(--mao-canvas, #f5f5f7);
}

.rm-row.is-checked {
  background: var(--mao-accent-bg, rgba(0, 102, 204, 0.08));
}

.rm-row.is-flash {
  animation: rm-flash 1.8s ease-out;
}

@keyframes rm-flash {
  0%, 30% { background: rgba(26, 127, 55, 0.16); }
  100% { background: transparent; }
}

.rm-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--mao-accent, #0066cc);
  background: var(--mao-accent-bg, rgba(0, 102, 204, 0.08));
}

.rm-panel--members .rm-avatar {
  color: var(--mao-success, #1a7f37);
  background: rgba(26, 127, 55, 0.1);
}

.rm-info {
  flex: 1;
  min-width: 0;
}

.rm-name {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 20px;
}

.rm-display {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mao-ink, #1d1d1f);
}

.rm-sub {
  font-size: 12px;
  line-height: 18px;
  color: var(--mao-muted, #6e6e73);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-quick {
  flex: none;
  opacity: 0;
  transition: opacity 0.15s;
}

.rm-row:hover .rm-quick,
.rm-row:focus-within .rm-quick {
  opacity: 1;
}

@media (hover: none) {
  .rm-quick {
    opacity: 1;
  }
}

.rm-foot {
  display: flex;
  justify-content: center;
  padding: 6px 8px 10px;
  border-top: 1px solid var(--mao-border, #e0e0e0);
}

@media (max-width: 768px) {
  .rm-list {
    height: 260px;
  }
}
</style>
