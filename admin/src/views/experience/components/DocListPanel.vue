<template>
  <section class="doc-list-panel">
    <el-empty
      v-if="store.libraries.length === 0 && store.orphans.length === 0"
      description="暂无经验库；Agent 完成复杂任务后会自行沉淀"
      :image-size="90"
    />
    <template v-else>
      <!-- 库选择 + 统计（替代侧栏：库数量级小，下拉即可） -->
      <div class="library-bar">
        <el-select
          :model-value="store.selectedAgentId"
          class="library-select"
          filterable
          aria-label="选择 Agent 经验库"
          @update:model-value="store.selectAgent(Number($event))"
        >
          <el-option v-for="lib in store.libraries" :key="lib.agentId" :value="lib.agentId" :label="lib.agentName">
            <div class="lib-option">
              <span class="status-dot" :class="lib.enabled ? 'is-on' : 'is-off'" />
              <span class="lib-option-name">{{ lib.agentName }}</span>
              <span class="lib-option-meta">{{ lib.docCount }} 篇 · {{ formatSize(lib.totalBytes) }}</span>
            </div>
          </el-option>
        </el-select>
        <span v-if="selectedLibrary" class="library-stats">
          {{ selectedLibrary.docCount }} 篇 · {{ formatSize(selectedLibrary.totalBytes) }} · 最近更新 {{ formatDate(selectedLibrary.lastUpdatedAt) }}
        </span>
        <div class="library-bar-actions">
          <el-button size="small" :disabled="store.selectedAgentId == null" @click="store.openIndex()">索引</el-button>
          <el-button size="small" type="primary" :disabled="!canWrite || store.selectedAgentId == null" @click="store.openCreate()">
            新建经验
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="store.orphans.length > 0"
        class="orphan-hint"
        type="warning"
        :closable="false"
        show-icon
        :title="`另有 ${store.orphans.length} 个孤儿库（Agent 已删除、目录残留）：${orphanText}`"
      />

      <el-form :inline="true" class="filter-form" @submit.prevent>
        <el-form-item label="搜索">
          <el-input
            v-model="keywordInput"
            placeholder="文件名/标题/关键词/摘要/适用"
            clearable
            style="width: 190px"
            aria-label="搜索经验文档"
            @keyup.enter="submitSearch"
            @clear="submitSearch"
          />
        </el-form-item>
        <el-form-item label="关键词">
          <el-select
            :model-value="store.tag"
            clearable
            filterable
            remote
            :remote-method="onTagSearch"
            :loading="store.tagSearching"
            placeholder="输入搜索标签"
            style="width: 170px"
            aria-label="按关键词标签筛选"
            @update:model-value="store.setTag(String($event ?? ''))"
          >
            <el-option v-for="f in tagOptions" :key="f.tag" :label="tagLabel(f)" :value="f.tag" />
            <el-option
              v-if="tagTruncated"
              key="__tag-hint__"
              value="__tag-hint__"
              disabled
              :label="`共 ${tagTotal} 个标签，输入可缩小范围`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="最后验证">
          <el-date-picker
            :model-value="store.verifiedRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            value-format="YYYY-MM-DD"
            style="width: 220px"
            aria-label="按最后验证日期筛选"
            @update:model-value="store.setVerifiedRange($event as [string, string] | null)"
          />
        </el-form-item>
        <el-form-item label="更新时间">
          <el-date-picker
            :model-value="store.updatedRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            value-format="YYYY-MM-DD"
            style="width: 220px"
            aria-label="按更新时间筛选"
            @update:model-value="store.setUpdatedRange($event as [string, string] | null)"
          />
        </el-form-item>
        <el-form-item label="异常">
          <el-select
            :model-value="store.abnormal"
            clearable
            placeholder="全部"
            style="width: 130px"
            aria-label="异常文档筛选"
            @update:model-value="store.setAbnormal(String($event ?? '') as AbnormalFilter)"
          >
            <el-option label="无 frontmatter" value="no-frontmatter" />
            <el-option label="无标题" value="no-title" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="submitSearch">查询</el-button>
          <el-button @click="store.resetFilters()">重置</el-button>
        </el-form-item>
      </el-form>

      <div class="list-toolbar">
        <div class="list-controls">
          <el-select
            :model-value="store.groupBy"
            style="width: 110px"
            aria-label="分组方式"
            @update:model-value="store.setGroupBy(String($event) as GroupBy)"
          >
            <el-option label="按月分组" value="month" />
            <el-option label="按关键词" value="keyword" />
            <el-option label="平铺" value="none" />
          </el-select>
          <el-select
            :model-value="store.sort"
            style="width: 110px"
            aria-label="排序字段"
            @update:model-value="store.setSort(String($event) as SortField)"
          >
            <el-option label="文件名" value="fileName" />
            <el-option label="标题" value="title" />
            <el-option label="更新时间" value="updatedAt" />
            <el-option label="最后验证" value="lastVerified" />
            <el-option label="大小" value="sizeBytes" />
          </el-select>
          <el-button
            :title="store.order === 'desc' ? '当前降序，点击切换升序' : '当前升序，点击切换降序'"
            :aria-label="store.order === 'desc' ? '切换为升序' : '切换为降序'"
            @click="store.toggleOrder()"
          >
            <el-icon><component :is="store.order === 'desc' ? SortDown : SortUp" /></el-icon>
          </el-button>
        </div>
      </div>

      <el-table
        v-loading="store.listLoading"
        :data="tableRows"
        size="small"
        :span-method="spanMethod"
        :row-class-name="rowClassName"
        class="doc-table"
        @row-click="onRowClick"
      >
        <el-table-column label="文件名" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.isGroup" class="group-cell">{{ row.key }} · {{ row.count }} 篇</span>
            <span v-else class="file-name">{{ row.doc.fileName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="关键词" min-width="150">
          <template #default="{ row }">
            <template v-if="!row.isGroup && tagsOf(row.doc).length > 0">
              <el-tag v-for="t in tagsOf(row.doc).slice(0, 3)" :key="t" size="small" type="info" class="kw-tag">{{ t }}</el-tag>
              <span v-if="tagsOf(row.doc).length > 3" class="kw-more">+{{ tagsOf(row.doc).length - 3 }}</span>
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="最后验证" width="130">
          <template #default="{ row }">
            <template v-if="!row.isGroup">
              {{ row.doc.lastVerified || '—' }}
              <el-tag v-if="isStaleVerified(row.doc.lastVerified)" size="small" type="info">久未验证</el-tag>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span v-if="!row.isGroup">{{ formatDateTime(row.doc.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <template v-if="!row.isGroup">
              <el-button link type="primary" size="small" @click.stop="store.openDoc(row.doc.fileName)">查看</el-button>
              <el-button link type="primary" size="small" :disabled="!canWrite" @click.stop="store.openDoc(row.doc.fileName, 'edit')">
                编辑
              </el-button>
              <el-button link type="danger" size="small" :disabled="!canWrite" @click.stop="store.deleteDoc(row.doc)">删除</el-button>
            </template>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            :description="hasFilter ? '无匹配文档，可调整或清空筛选' : '暂无经验文档；Agent 完成复杂任务后会自行沉淀，也可在此新建'"
            :image-size="70"
          />
        </template>
      </el-table>

      <ResponsivePagination
        class="pagination"
        :current-page="store.page"
        :page-size="store.pageSize"
        :total="store.total"
        layout="total, prev, pager, next"
        @current-change="store.turnPage"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { SortDown, SortUp } from '@element-plus/icons-vue'
import { formatDateTime } from '../../../utils/datetime'
import { useAuthStore } from '../../../stores/auth'
import ResponsivePagination from '../../../components/ResponsivePagination.vue'
import { EXPERIENCE_LIBRARY_KEY, type AbnormalFilter, type ExperienceDoc, type GroupBy, type KeywordFacet, type SortField } from '../composables/useExperienceLibrary'
import { formatDate, formatSize, groupKeyOf, isStaleVerified, splitKeywords } from '../experience-format'

const store = inject(EXPERIENCE_LIBRARY_KEY)!
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

const selectedLibrary = computed(() =>
  store.libraries.find((lib) => lib.agentId === store.selectedAgentId) ?? null,
)

const orphanText = computed(() => store.orphans.map((o) => `#${o.agentId}（${o.docCount} 篇）`).join('、'))

const keywordInput = ref(store.keyword)
watch(() => store.keyword, (value) => { keywordInput.value = value })

function submitSearch(): void {
  store.search(keywordInput.value)
}

/** 下拉候选：远程搜索结果优先，未搜索时用列表接口带回的全库 top50。 */
const tagOptions = computed<KeywordFacet[]>(() => {
  const base = store.tagSearchFacets ?? store.keywordFacets
  // 已选 tag 可能来自阅读页点击（长尾标签，不在候选里）：补一条无计数占位，避免下拉回显裸值
  if (store.tag !== '' && !base.some((f) => f.tag === store.tag)) {
    return [{ tag: store.tag, count: 0 }, ...base]
  }
  return base
})

const tagTotal = computed(() => (store.tagSearchFacets !== null ? store.tagSearchTotal : store.keywordFacetsTotal))
const tagTruncated = computed(() => tagTotal.value > (store.tagSearchFacets ?? store.keywordFacets).length)

function tagLabel(facet: KeywordFacet): string {
  return facet.count > 0 ? `${facet.tag}（${facet.count}）` : facet.tag
}

/** 输入防抖：连打时只发最后一次，避免每个字符一次全库扫描。 */
let tagSearchTimer: ReturnType<typeof setTimeout> | null = null
function onTagSearch(query: string): void {
  if (tagSearchTimer) clearTimeout(tagSearchTimer)
  tagSearchTimer = setTimeout(() => {
    tagSearchTimer = null
    void store.searchTags(query)
  }, 250)
}

onBeforeUnmount(() => {
  if (tagSearchTimer) clearTimeout(tagSearchTimer)
})

const hasFilter = computed(() =>
  store.keyword.trim() !== '' ||
  store.tag !== '' ||
  store.verifiedRange != null ||
  store.updatedRange != null ||
  store.abnormal !== '',
)

function tagsOf(doc: { keywords: string }): string[] {
  return splitKeywords(doc.keywords)
}

interface GroupRow { isGroup: true; key: string; count: number }
interface DocRow { isGroup?: false; doc: ExperienceDoc }
type TableRow = GroupRow | DocRow

/** 分组展示：组头恒展示（计数为服务端全量口径），组内行取当前页数据（技术方案 §3.3）。 */
const tableRows = computed<TableRow[]>(() => {
  const groupBy = store.groupBy
  if (groupBy === 'none') return store.docs.map((doc) => ({ doc }))
  const rows: TableRow[] = []
  for (const group of store.groupCounts) {
    rows.push({ isGroup: true, key: group.key, count: group.count })
    for (const doc of store.docs) {
      if (groupKeyOf(doc, groupBy) === group.key) rows.push({ doc })
    }
  }
  return rows
})

const COLUMN_COUNT = 5

function spanMethod({ row, columnIndex }: { row: TableRow; columnIndex: number }): { rowspan: number; colspan: number } | undefined {
  if (!row.isGroup) return undefined
  return columnIndex === 0 ? { rowspan: 1, colspan: COLUMN_COUNT } : { rowspan: 0, colspan: 0 }
}

function rowClassName({ row }: { row: TableRow }): string {
  return row.isGroup ? 'is-group-row' : 'is-doc-row'
}

function onRowClick(row: TableRow): void {
  if (!row.isGroup) store.openDoc(row.doc.fileName)
}
</script>

<style scoped>
.doc-list-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.library-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.library-select {
  width: 240px;
  flex-shrink: 0;
}
.lib-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.lib-option-name {
  font-weight: 600;
}
.lib-option-meta {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.is-on {
  background: var(--el-color-success);
}
.status-dot.is-off {
  background: var(--el-text-color-disabled);
}
.library-stats {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.library-bar-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.library-bar-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.orphan-hint {
  --el-alert-padding: 6px 12px;
}
.filter-form {
  margin-bottom: 0;
}
.filter-form :deep(.el-form-item) {
  margin-bottom: 8px;
  margin-right: 12px;
}
.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.list-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.doc-table :deep(.is-group-row) {
  background: var(--el-fill-color-light);
}
.doc-table :deep(.is-group-row td.el-table__cell) {
  background: var(--el-fill-color-light);
}
.group-cell {
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.doc-table :deep(.is-doc-row) {
  cursor: pointer;
}
.file-name {
  color: var(--el-color-primary);
}
.kw-tag {
  margin-right: 4px;
}
.kw-more {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pagination {
  margin-top: 8px;
  justify-content: flex-end;
}
</style>
