<template>
  <el-dialog
    :model-value="visible"
    title="选择脚本文件"
    width="min(520px, calc(100vw - 32px))"
    class="signal-dialog"
    @update:model-value="(val: boolean) => { if (!val) emit('update:visible', false) }"
  >
    <div class="picker-body">
      <el-select
        :model-value="currentProject"
        placeholder="选择项目工作区"
        filterable
        style="width: 100%"
        :loading="projectsLoading"
        @change="(slug: string) => { enterProject(slug) }"
      >
        <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
      </el-select>

      <div v-if="currentProject != null" class="picker-crumb">
        <span class="crumb-root">{{ currentProject }}</span>
        <template v-for="(seg, index) in crumbs" :key="index">
          <span class="crumb-sep">/</span>
          <a class="crumb-link" @click="enterDir(crumbs.slice(0, index + 1).join('/'))">{{ seg }}</a>
        </template>
      </div>

      <div v-if="entriesLoading" class="picker-empty">加载中...</div>
      <div v-else-if="currentProject == null" class="picker-empty">先选择一个项目工作区</div>
      <div v-else-if="entries.length === 0" class="picker-empty">目录为空</div>
      <div v-else class="picker-list">
        <button
          v-for="entry in entries"
          :key="entry.path"
          type="button"
          class="picker-row"
          :title="entry.isDirectory ? '进入目录' : '选择该文件'"
          @click="entry.isDirectory ? enterDir(entry.path) : selectFile(entry)"
        >
          <el-icon :size="14">
            <Folder v-if="entry.isDirectory" />
            <Document v-else />
          </el-icon>
          <span class="picker-name">{{ entry.name }}</span>
          <span v-if="!entry.isDirectory" class="picker-size">{{ formatSize(entry.size) }}</span>
        </button>
      </div>
    </div>
    <template #footer>
      <button class="dialog-btn dialog-btn-cancel" @click="emit('update:visible', false)">取消</button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 脚本路径选择器（V189）：项目工作区（overview kind='project'）→ project-directory 逐级浏览 → 选文件。
// 数据面全部复用既有 API，不改后端；回填值是 `<slug>/<子路径>` 相对路径，由后端做属主与越界校验。
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, Folder } from '@element-plus/icons-vue'
import { api, fetchWorkspaceOverview } from '../../api'

interface ProjectDirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  isSymlink: boolean
}

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  'update:visible': [visible: boolean]
  /** 选中脚本文件的相对路径：`<slug>/<子路径>` */
  select: [scriptPath: string]
}>()

const projects = ref<string[]>([])
const projectsLoading = ref(false)
const currentProject = ref<string | null>(null)
const currentDir = ref<string | null>(null)
const entries = ref<ProjectDirectoryEntry[]>([])
const entriesLoading = ref(false)

const crumbs = computed<string[]>(() => currentDir.value == null ? [] : currentDir.value.split('/').filter((seg) => seg !== ''))

async function fetchProjects(): Promise<void> {
  projectsLoading.value = true
  try {
    const result = await fetchWorkspaceOverview()
    projects.value = (result.entries ?? [])
      .filter((entry) => entry.kind === 'project')
      .map((entry) => entry.name)
  } catch {
    projects.value = []
  } finally {
    projectsLoading.value = false
  }
}

async function fetchEntries(): Promise<void> {
  if (currentProject.value == null) {
    entries.value = []
    return
  }
  entriesLoading.value = true
  try {
    const { data } = await api.get('/files/project-directory', {
      params: { projectKey: currentProject.value, dir: currentDir.value || undefined },
    })
    // 目录在前、文件在后（各自按名排序），浏览体验与文件管理器一致
    const list = (data?.entries ?? []) as ProjectDirectoryEntry[]
    entries.value = [...list.filter((e) => e.isDirectory), ...list.filter((e) => !e.isDirectory)]
  } catch {
    entries.value = []
  } finally {
    entriesLoading.value = false
  }
}

function enterProject(slug: string): void {
  currentProject.value = slug
  currentDir.value = null
  void fetchEntries()
}

function enterDir(dir: string): void {
  currentDir.value = dir
  void fetchEntries()
}

function selectFile(entry: ProjectDirectoryEntry): void {
  if (currentProject.value == null) return
  // 目录内相对路径已含子目录：拼上 slug 即哨兵存储约定 `<slug>/<子路径>`
  const scriptPath = `${currentProject.value}/${entry.path}`
  emit('select', scriptPath)
  emit('update:visible', false)
  ElMessage.success(`已选择：${scriptPath}`)
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / (1024 * 1024)).toFixed(1)}MB`
}

watch(() => props.visible, (visible) => {
  if (visible && projects.value.length === 0) void fetchProjects()
})
</script>

<style scoped>
.picker-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.picker-crumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.crumb-root {
  font-weight: 600;
  color: var(--aw-ink);
}

.crumb-sep {
  color: var(--aw-ink-muted-40);
}

.crumb-link {
  color: var(--aw-primary);
  cursor: pointer;
}

.crumb-link:hover {
  text-decoration: underline;
}

.picker-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.picker-list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--aw-ink);
}

.picker-row:hover {
  background: var(--aw-surface-hover);
}

.picker-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-size {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aw-ink-muted);
}
</style>
