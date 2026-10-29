<template>
  <div class="git-compare-view">
    <!-- 选择行：两个分支下拉（本地 / 远端分组，当前分支加 ✓）+ 交换按钮 -->
    <div class="git-compare-selects">
      <el-select
        :model-value="compareBase"
        class="git-compare-select"
        placeholder="选择基准分支"
        filterable
        :reserve-keyword="false"
        size="small"
        @update:model-value="(value: string) => emit('update:compareBase', value)"
      >
        <el-option-group label="本地分支">
          <el-option
            v-for="branch in localBranches"
            :key="branch.name"
            :value="branch.name"
            :label="labelOf(branch)"
          />
        </el-option-group>
        <el-option-group v-if="remoteBranches.length > 0" label="远端分支">
          <el-option
            v-for="branch in remoteBranches"
            :key="branch.name"
            :value="branch.name"
            :label="branch.name"
          />
        </el-option-group>
      </el-select>
      <button
        class="git-compare-swap"
        :disabled="!compareBase && !compareTarget"
        title="交换基准 / 目标"
        aria-label="交换基准与目标"
        @click="swapBranches"
      >⇄</button>
      <el-select
        :model-value="compareTarget"
        class="git-compare-select"
        placeholder="选择目标分支"
        filterable
        :reserve-keyword="false"
        size="small"
        @update:model-value="(value: string) => emit('update:compareTarget', value)"
      >
        <el-option-group label="本地分支">
          <el-option
            v-for="branch in localBranches"
            :key="branch.name"
            :value="branch.name"
            :label="labelOf(branch)"
          />
        </el-option-group>
        <el-option-group v-if="remoteBranches.length > 0" label="远端分支">
          <el-option
            v-for="branch in remoteBranches"
            :key="branch.name"
            :value="branch.name"
            :label="branch.name"
          />
        </el-option-group>
      </el-select>
    </div>

    <!-- 结果区：分支加载 → 选择态 → 对比请求态 → 汇总条 + 目录分组树 -->
    <div class="git-compare-body">
      <div v-if="branchesError && branches.length === 0" class="git-state git-error">
        <p>{{ branchesError }}</p>
        <button class="git-retry" @click="emit('retry-branches')">重试</button>
      </div>
      <div v-else-if="branchesLoading && branches.length === 0" class="git-state">加载中…</div>
      <div v-else-if="branches.length === 0" class="git-state">没有可用分支</div>
      <div v-else-if="!compareBase || !compareTarget" class="git-state">请选择两个分支开始对比</div>
      <div v-else-if="compareBase === compareTarget" class="git-state">两个分支相同，没有差异可对比</div>
      <div v-else-if="compareLoading" class="git-state">加载中…</div>
      <div v-else-if="compareError" class="git-state git-error">
        <p>{{ compareError }}</p>
        <button class="git-retry" @click="emit('retry')">重试</button>
      </div>
      <div v-else-if="!compareResult" class="git-state">加载中…</div>
      <template v-else>
        <div class="git-compare-summary">
          <span class="git-compare-direction">
            <span class="git-compare-ref">{{ compareResult.base }}</span>
            <span class="git-compare-arrow">→</span>
            <span class="git-compare-ref">{{ compareResult.target }}</span>
          </span>
          <span class="git-compare-ahead">↑{{ compareResult.aheadCount }} 领先</span>
          <span class="git-compare-behind">↓{{ compareResult.behindCount }} 落后</span>
          <span>{{ compareResult.files.length }} 个文件</span>
          <span class="git-compare-lines">
            <span class="add">+{{ totalInsertions }}</span>
            <span class="del">-{{ totalDeletions }}</span>
          </span>
        </div>
        <div v-if="compareResult.files.length === 0" class="git-state">两个分支当前内容完全一致</div>
        <div v-else class="git-compare-tree">
          <GitChangeTreeNode
            v-for="node in treeRoots"
            :key="node.path"
            :node="node"
            :depth="0"
            :collapsed="collapsed"
            deleted-tag="仅基准分支"
            @toggle="toggleDir"
            @open-diff="handleOpenDiff"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import GitChangeTreeNode from '../task/GitChangeTreeNode.vue'
import type { GitBranchCompareResult, GitBranchInfo, GitChangedFile } from '../../types/git'
import { buildGitTree, collectDirPaths } from '../../utils/git-manager'

const props = defineProps<{
  /** 分支下拉选项（本地 + 远端全量，来自 useGitManager.branches） */
  branches: GitBranchInfo[]
  branchesLoading: boolean
  branchesError: string
  /** 基准分支（空串 = 未选）；进入视图默认预选「当前分支 upstream → 当前分支」（仅空槽填充），可随时改选、不联动 */
  compareBase: string
  /** 目标分支（空串 = 未选）；分支行「对比」入口只会预填本槽 */
  compareTarget: string
  compareResult: GitBranchCompareResult | null
  compareLoading: boolean
  compareError: string
}>()

const emit = defineEmits<{
  'update:compareBase': [value: string]
  'update:compareTarget': [value: string]
  retry: []
  'retry-branches': []
  'open-diff': [payload: { base: string; target: string; file: GitChangedFile }]
}>()

const localBranches = computed(() => props.branches.filter((b) => !b.isRemote))
const remoteBranches = computed(() => props.branches.filter((b) => b.isRemote))

/** 下拉选项文案：当前分支加 ✓ 标记（与分支视图同款） */
function labelOf(branch: GitBranchInfo) {
  return branch.isCurrent ? `✓ ${branch.name}` : branch.name
}

/** 目录折叠态由本组件自持（默认全展开；面板子视图无 KeepAlive，切子导航复位属预期） */
const collapsed = reactive(new Set<string>())

const treeRoots = computed(() => (props.compareResult ? buildGitTree(props.compareResult.files) : []))

// 对比结果刷新后清理已不存在的折叠目录（与 GitChangeList 同口径）
watch(
  () => props.compareResult,
  () => {
    const valid = new Set<string>()
    collectDirPaths(treeRoots.value, valid)
    for (const path of [...collapsed]) {
      if (!valid.has(path)) collapsed.delete(path)
    }
  },
)

function toggleDir(path: string) {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

const totalInsertions = computed(() =>
  (props.compareResult?.files ?? []).reduce((sum, file) => sum + (file.insertions ?? 0), 0),
)
const totalDeletions = computed(() =>
  (props.compareResult?.files ?? []).reduce((sum, file) => sum + (file.deletions ?? 0), 0),
)

/** 交换基准 / 目标：两次 selection 变更各触发一次 watch，最终一次 loadCompare（相同槽位会被跳过） */
function swapBranches() {
  const base = props.compareBase
  const target = props.compareTarget
  emit('update:compareBase', target)
  emit('update:compareTarget', base)
}

function handleOpenDiff(file: GitChangedFile) {
  emit('open-diff', { base: props.compareBase, target: props.compareTarget, file })
}
</script>

<style scoped>
.git-compare-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.git-compare-selects {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.git-compare-select {
  flex: 1;
  min-width: 140px;
}

.git-compare-select :deep(.el-select__wrapper) {
  min-height: 30px;
  padding: 2px 9px 2px 10px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-pearl);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
}

.git-compare-select :deep(.el-select__selected-item),
.git-compare-select :deep(.el-select__input) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

.git-compare-swap {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-primary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.git-compare-swap:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.git-compare-swap:disabled {
  opacity: 0.4;
  cursor: default;
}

.git-compare-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.git-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.git-error p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

.git-compare-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
}

.git-compare-ahead {
  color: var(--aw-diff-add);
}

.git-compare-direction {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-compare-arrow {
  color: var(--aw-ink-muted-48);
}

.git-compare-behind {
  color: var(--aw-diff-del);
}

.git-compare-lines {
  display: inline-flex;
  gap: 6px;
  font-family: var(--aw-font-mono);
}

.git-compare-lines .add {
  color: var(--aw-diff-add);
}

.git-compare-lines .del {
  color: var(--aw-diff-del);
}

.git-compare-tree {
  padding-bottom: 8px;
}

[data-theme="dark"] .git-compare-selects,
[data-theme="dark"] .git-compare-summary {
  border-bottom-color: var(--aw-hairline);
}
</style>
