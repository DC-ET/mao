<template>
  <div class="skill-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Skills 管理</span>
          <el-tag type="info" size="small">按 Skill 目录包规范管理，每个包必须包含顶层 SKILL.md。</el-tag>
        </div>
      </template>

      <el-tabs v-model="activeTab" class="skill-tabs" :before-leave="beforeLeaveSkillTab" @tab-change="handleTabChange">
        <el-tab-pane label="系统 Skills" name="system" />
        <el-tab-pane label="个人 Skills" name="personal" />
      </el-tabs>

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键词">
          <el-input
            v-model="keyword"
            clearable
            :placeholder="activeTab === 'personal' ? '名称 / 描述 / 用户' : '名称 / 描述'"
            style="width: 220px"
          />
        </el-form-item>
        <el-form-item v-if="activeTab === 'personal'" label="用户">
          <el-select
            v-model="filterUserId"
            clearable
            filterable
            placeholder="全部用户"
            style="width: 220px"
          >
            <el-option
              v-for="user in personalUserOptions"
              :key="user.id"
              :label="userOptionLabel(user)"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <!-- System tab: upload area -->
      <template v-if="activeTab === 'system'">
        <el-alert
          v-if="isMobile"
          type="info"
          :closable="false"
          show-icon
          title="手机端可查看、删除已有 Skill；上传目录包请在电脑浏览器完成。"
          style="margin-bottom: 12px"
        />
        <div
          v-else
          class="upload-zone"
          :class="{ 'is-dragover': isDragover }"
          v-loading="uploadBusy"
          element-loading-text="上传中..."
          @dragover.prevent="isDragover = true"
          @dragleave.prevent="isDragover = false"
          @drop.prevent="handleDrop"
          @click="triggerFileInput"
        >
          <input
            ref="fileInputRef"
            type="file"
            webkitdirectory
            multiple
            style="display: none"
            @change="handleFileInputChange"
          />
          <el-icon class="upload-icon"><UploadFilled /></el-icon>
          <div class="upload-text">拖动或点击上传 Skills 目录</div>
          <div class="upload-hint">可一次选择或拖入一个或多个包含 SKILL.md 的目录。node_modules、.git、dist 等目录会跳过。</div>
        </div>
      </template>
      <template v-else>
        <el-alert
          v-if="isMobile"
          type="info"
          :closable="false"
          show-icon
          title="手机端可查看、删除已有个人 Skill；上传到指定用户请在电脑浏览器完成。"
          style="margin-bottom: 12px"
        />
        <el-alert
          v-else-if="!canWrite"
          type="info"
          :closable="false"
          show-icon
          title="当前账号只能查看个人 Skills。上传到指定用户需要管理 Agent 权限。"
          style="margin-bottom: 12px"
        />
        <template v-else>
          <el-form :inline="true" class="assign-form" @submit.prevent>
            <el-form-item label="目标用户">
              <el-select
                v-model="assignUserIds"
                multiple
                filterable
                collapse-tags
                collapse-tags-tooltip
                clearable
                placeholder="选择要添加个人技能的用户"
                style="width: 420px"
              >
                <el-option
                  v-for="user in userOptions"
                  :key="user.id"
                  :label="userOptionLabel(user)"
                  :value="user.id"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <div
            class="upload-zone"
            :class="{ 'is-dragover': isDragover, 'is-blocked': assignUserIds.length === 0 }"
            v-loading="uploadBusy"
            element-loading-text="上传中..."
            @dragover.prevent="isDragover = true"
            @dragleave.prevent="isDragover = false"
            @drop.prevent="handleDrop"
            @click="triggerFileInput"
          >
            <input
              ref="fileInputRef"
              type="file"
              webkitdirectory
              multiple
              style="display: none"
              @change="handleFileInputChange"
            />
            <el-icon class="upload-icon"><UploadFilled /></el-icon>
            <div class="upload-text">拖动或点击上传到所选用户</div>
            <div class="upload-hint">只写入所选用户的个人技能，不会成为系统技能，也不影响其他用户。同名技能会被覆盖，并在这些用户的所有智能体中生效。node_modules、.git、dist 等目录会跳过。</div>
          </div>
        </template>
      </template>

      <!-- System skill table -->
      <el-table
        v-if="activeTab === 'system' && !isMobile"
        :data="pagedSkillDocs"
        v-loading="loading"
        stripe
        style="margin-top: 16px"
      >
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column prop="description" label="描述" min-width="300" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tooltip v-if="!isSkillAvailable(row)" content="缺少 SKILL.md 或目录包不完整，运行时无法加载" placement="top">
              <el-tag type="danger" size="small">不可用</el-tag>
            </el-tooltip>
            <el-tag v-else type="success" size="small">可用</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关联 Agent" width="110" align="right" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ relatedAgentCount(row.name) }}</template>
        </el-table-column>
        <el-table-column prop="folderPath" label="路径" min-width="250" show-overflow-tooltip class-name="hide-on-mobile" label-class-name="hide-on-mobile" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看内容</el-button>
            <el-popconfirm
              :title="`确认删除 Skill「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small" :disabled="!canWrite">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!-- Personal skill table -->
      <el-table
        v-else-if="activeTab === 'personal' && !isMobile"
        :data="pagedPersonalSkills"
        v-loading="loading"
        stripe
        style="margin-top: 16px"
      >
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column label="用户" width="140">
          <template #default="{ row }">
            <el-tooltip :content="`ID: ${row.userId}`" placement="top">
              <span>{{ row.displayName || row.username || `用户#${row.userId}` }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column prop="description" label="描述" min-width="260" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tooltip v-if="!isSkillAvailable(row)" content="缺少 SKILL.md 或目录包不完整，运行时无法加载" placement="top">
              <el-tag type="danger" size="small">不可用</el-tag>
            </el-tooltip>
            <el-tag v-else type="success" size="small">可用</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="folderPath" label="路径" min-width="250" show-overflow-tooltip class-name="hide-on-mobile" label-class-name="hide-on-mobile" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看内容</el-button>
            <el-popconfirm
              :title="`确认删除「${userLabel(row)}」的 Skill「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small" :disabled="!canWrite">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile cards -->
      <div
        v-else-if="isMobile"
        class="mobile-card-list"
        v-loading="loading"
        style="margin-top: 16px"
      >
        <el-card v-for="row in mobileRows" :key="mobileKey(row)" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="isSkillAvailable(row) ? 'success' : 'danger'" size="small">
              {{ isSkillAvailable(row) ? '可用' : '不可用' }}
            </el-tag>
          </div>
          <div v-if="activeTab === 'personal'" class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ userLabel(row) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">描述</span>
            <span>{{ row.description || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">状态</span>
            <el-tooltip v-if="!isSkillAvailable(row)" content="缺少 SKILL.md 或目录包不完整，运行时无法加载" placement="top">
              <el-tag type="danger" size="small">不可用</el-tag>
            </el-tooltip>
            <el-tag v-else type="success" size="small">可用</el-tag>
          </div>
          <div class="mobile-card-actions">
            <el-button type="primary" link @click="handleView(row)">查看</el-button>
            <el-popconfirm
              :title="`确认删除 Skill「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <!-- 与桌面表格一致：系统与个人 Skills 的删除都要求 agent:write，
                     早期写成 activeTab === 'personal' && !canWrite，系统 Tab 恒为可点 -->
                <el-button type="danger" link :disabled="!canWrite">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </el-card>
        <el-empty v-if="!loading && mobileRows.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        v-if="total > 0"
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @size-change="handleSizeChange"
      />
    </el-card>

    <!-- Skill content dialog -->
    <ResponsiveDialog
      v-if="detailVisible"
      v-model="detailVisible"
      :title="`Skill: ${currentDoc?.name || ''}`"
      width="700px"
    >
      <div v-if="currentDoc" class="skill-detail">
        <p v-if="currentDoc.userId != null"><strong>用户：</strong>{{ currentDoc.username || currentDoc.displayName || `用户#${currentDoc.userId}` }}</p>
        <p><strong>描述：</strong>{{ currentDoc.description }}</p>
        <p><strong>文件路径：</strong>{{ currentDoc.filePath }}</p>
        <el-divider />
        <div class="skill-body">
          <pre>{{ currentDoc.body }}</pre>
        </div>
      </div>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

const { isMobile } = useBreakpoint()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

const activeTab = ref<'system' | 'personal'>('system')
const loading = ref(false)
const skillDocs = ref<any[]>([])
const personalSkills = ref<any[]>([])
const agents = ref<any[]>([])
const keyword = ref('')
const filterUserId = ref<number | null>(null)
const currentPage = ref(1)
const pageSize = ref(10)
const detailVisible = ref(false)
const currentDoc = ref<any>(null)
const isDragover = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploadBusy = ref(false)
const userOptions = ref<Array<{ id: number; username?: string | null; displayName?: string | null }>>([])
const assignUserIds = ref<number[]>([])

async function fetchSkillDocs() {
  loading.value = true
  try {
    const [{ data }, agentRes] = await Promise.all([
      api.get('/skill-docs'),
      api.get('/agents', { params: { includeDisabled: true } })
    ])
    skillDocs.value = data || []
    agents.value = agentRes.data || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loading.value = false
  }
}

async function fetchPersonalSkills() {
  loading.value = true
  try {
    const skillsReq = api.get('/admin/user-skills')
    const usersReq = api.get('/admin/user-skills/options/users').catch(() => null)
    const skillsRes = await skillsReq
    personalSkills.value = skillsRes.data || []
    const usersRes = await usersReq
    if (usersRes) userOptions.value = usersRes.data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loading.value = false
  }
}

async function fetchActiveTab() {
  if (activeTab.value === 'personal') {
    await fetchPersonalSkills()
  } else {
    await fetchSkillDocs()
  }
}

function handleTabChange(tab: string | number) {
  void (tab === 'personal' ? fetchPersonalSkills() : fetchSkillDocs())
}

const filteredSkillDocs = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return skillDocs.value
  return skillDocs.value.filter(doc =>
    `${doc.name || ''} ${doc.description || ''}`.toLowerCase().includes(kw))
})

const personalUserOptions = computed(() => {
  const seen = new Map<number, { id: number; username?: string | null; displayName?: string | null }>()
  for (const row of personalSkills.value) {
    const userId = Number(row.userId)
    if (!Number.isInteger(userId) || userId <= 0 || seen.has(userId)) continue
    const known = userOptions.value.find((user) => user.id === userId)
    seen.set(userId, {
      id: userId,
      username: row.username ?? known?.username,
      displayName: row.displayName ?? known?.displayName,
    })
  }
  return [...seen.values()].sort((a, b) => userOptionLabel(a).localeCompare(userOptionLabel(b), 'zh'))
})

const filteredPersonalSkills = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const userId = filterUserId.value
  return personalSkills.value.filter((row) => {
    if (userId != null && Number(row.userId) !== userId) return false
    if (!kw) return true
    return `${row.name || ''} ${row.description || ''} ${row.username || ''} ${row.displayName || ''} ${row.userId ?? ''}`
      .toLowerCase().includes(kw)
  })
})

const filteredRows = computed(() =>
  activeTab.value === 'personal' ? filteredPersonalSkills.value : filteredSkillDocs.value)

const total = computed(() => filteredRows.value.length)

const pagedSkillDocs = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredSkillDocs.value.slice(start, start + pageSize.value)
})

const pagedPersonalSkills = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredPersonalSkills.value.slice(start, start + pageSize.value)
})

const mobileRows = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

// 关键词或 tab 变化后回第一页，避免停在已无数据的空页
watch([keyword, filterUserId, activeTab], () => {
  currentPage.value = 1
})

function handleSizeChange() {
  currentPage.value = 1
}

function mobileKey(row: any) {
  return activeTab.value === 'personal' ? `${row.userId}-${row.name}` : row.name
}

function userLabel(row: any) {
  return row.displayName || row.username || `用户#${row.userId}`
}

function userOptionLabel(user: { id: number; username?: string | null; displayName?: string | null }) {
  const name = user.displayName || user.username || `用户#${user.id}`
  if (user.username && user.displayName && user.displayName !== user.username) {
    return `${user.displayName}（${user.username}）`
  }
  return name
}

function relatedAgentCount(skillName: string) {
  return agents.value.filter(agent => (agent.skillNames || []).includes(skillName)).length
}

function isSkillAvailable(row: { filePath?: string; folderPath?: string }) {
  return !!(row.filePath || row.folderPath)
}

async function handleView(row: any) {
  try {
    if (activeTab.value === 'personal') {
      const { data } = await api.get(`/admin/user-skills/${row.userId}/${encodeURIComponent(row.name)}`)
      currentDoc.value = { ...data, userId: row.userId, username: row.username, displayName: row.displayName }
    } else {
      const { data } = await api.get(`/skill-docs/${row.name}`)
      currentDoc.value = data
    }
    detailVisible.value = true
  } catch {
    // Error handled by interceptor
  }
}

// ========== Upload ==========

type UploadTarget = { kind: 'system' } | { kind: 'personal'; userIds: number[] }

const SKILL_UPLOAD_EXCLUDED_DIRS = ['node_modules/', '.git/', '.svn/', 'dist/', '__MACOSX/']
const SKILL_UPLOAD_MAX_FILES = 500
const SKILL_UPLOAD_MAX_TOTAL = 50 * 1024 * 1024
const SKILL_UPLOAD_MAX_SINGLE = 20 * 1024 * 1024

function beforeLeaveSkillTab() {
  if (!uploadBusy.value) return true
  ElMessage.warning('正在处理上传，请稍候再切换')
  return false
}

function captureUploadTarget(): UploadTarget {
  if (activeTab.value === 'personal') {
    return { kind: 'personal', userIds: [...assignUserIds.value] }
  }
  return { kind: 'system' }
}

function triggerFileInput() {
  if (uploadBusy.value) return
  if (activeTab.value === 'personal' && assignUserIds.value.length === 0) {
    ElMessage.warning('请先选择要添加技能的用户')
    return
  }
  fileInputRef.value?.click()
}

function handleFileInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    const files = Array.from(input.files)
    const target = captureUploadTarget()
    input.value = '' // reset so same folder can be selected again
    void uploadFiles(files, target)
  }
}

async function handleDrop(e: DragEvent) {
  isDragover.value = false
  if (uploadBusy.value) return
  const target = captureUploadTarget()
  if (target.kind === 'personal' && target.userIds.length === 0) {
    ElMessage.warning('请先选择要添加技能的用户')
    return
  }
  const items = e.dataTransfer?.items
  if (!items) return

  uploadBusy.value = true
  const files: File[] = []
  const pending: Promise<void>[] = []
  const readState = { failed: false }

  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry) {
      pending.push(readEntryRecursive(entry, '', files, readState))
    }
  }

  try {
    await Promise.all(pending)
    if (readState.failed) {
      ElMessage.error('读取目录失败，已取消上传')
      return
    }
    if (files.length > 0) {
      await uploadFiles(files, target, { busyHeld: true })
    }
  } finally {
    uploadBusy.value = false
  }
}

function readEntryRecursive(
  entry: FileSystemEntry,
  basePath: string,
  files: File[],
  readState: { failed: boolean },
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry
      fileEntry.file((file) => {
        // Preserve the directory structure relative to the dropped root
        const relativePath = basePath ? `${basePath}/${file.name}` : file.name
        // Create a new File with the correct relative path
        const newFile = new File([file], relativePath, { type: file.type })
        files.push(newFile)
        resolve()
      }, () => {
        readState.failed = true
        resolve()
      })
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry
      const dirReader = dirEntry.createReader()
      const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name

      const readAll = (reader: FileSystemDirectoryReader, cb: (entries: FileSystemEntry[]) => void) => {
        reader.readEntries((entries) => {
          if (entries.length === 0) {
            cb([])
          } else {
            // Keep reading until empty
            readAll(reader, (moreEntries) => {
              cb([...entries, ...moreEntries])
            })
          }
        }, () => {
          readState.failed = true
          cb([])
        })
      }

      readAll(dirReader, (entries) => {
        const childPromises = entries.map((child) => readEntryRecursive(child, dirPath, files, readState))
        Promise.all(childPromises).then(() => resolve())
      })
    } else {
      resolve()
    }
  })
}

function assignTargetSummary(userIds: number[]) {
  const labels = userIds.map((id) => {
    const user = userOptions.value.find((item) => item.id === id)
    return user ? userOptionLabel(user) : `用户#${id}`
  })
  if (labels.length <= 8) return labels.join('、')
  return `${labels.slice(0, 8).join('、')} 等 ${labels.length} 人`
}

async function confirmAssignUpload(userIds: number[]) {
  try {
    await ElMessageBox.confirm(
      `将把技能写入以下用户的个人技能，不会成为系统技能，也不影响其他用户：${assignTargetSummary(userIds)}。同名个人技能会被覆盖，并在这些用户的所有智能体中生效。`,
      '添加到指定用户',
      { confirmButtonText: '上传', cancelButtonText: '取消', type: 'warning' },
    )
    return true
  } catch {
    return false
  }
}

function skillRelativePath(file: File) {
  const named = file as File & { webkitRelativePath?: string }
  return (named.webkitRelativePath || file.name).replace(/\\/g, '/')
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function prepareSkillUploadFiles(files: File[]) {
  const valid: File[] = []
  let totalSize = 0
  let excludedCount = 0
  for (const file of files) {
    const relativePath = skillRelativePath(file)
    if (SKILL_UPLOAD_EXCLUDED_DIRS.some((dir) => relativePath.includes(dir))) {
      excludedCount++
      continue
    }
    if (file.size > SKILL_UPLOAD_MAX_SINGLE) {
      ElMessage.error(`文件过大（${formatBytes(file.size)}）：${relativePath}，单文件上限 ${formatBytes(SKILL_UPLOAD_MAX_SINGLE)}`)
      return null
    }
    totalSize += file.size
    if (totalSize > SKILL_UPLOAD_MAX_TOTAL) {
      ElMessage.error(`上传总大小超过 ${formatBytes(SKILL_UPLOAD_MAX_TOTAL)} 上限，请精简技能目录后重试`)
      return null
    }
    valid.push(file)
  }
  if (valid.length > SKILL_UPLOAD_MAX_FILES) {
    ElMessage.error(`文件数量超过 ${SKILL_UPLOAD_MAX_FILES} 上限（当前 ${valid.length} 个），请精简技能目录后重试`)
    return null
  }
  if (valid.length === 0) {
    ElMessage.error(excludedCount > 0 ? '所选内容中无可上传的文件（已排除 node_modules/.git 等目录）' : '未选择任何文件')
    return null
  }
  return valid
}

async function uploadFiles(files: File[], target: UploadTarget, options?: { busyHeld?: boolean }) {
  if (uploadBusy.value && !options?.busyHeld) return
  if (!options?.busyHeld) uploadBusy.value = true
  let sent = false
  try {
    const prepared = prepareSkillUploadFiles(files)
    if (!prepared) return
    if (target.kind === 'personal') {
      if (target.userIds.length === 0) {
        ElMessage.warning('请先选择要添加技能的用户')
        return
      }
      if (!(await confirmAssignUpload(target.userIds))) return
    }

    const formData = new FormData()
    for (const file of prepared) {
      formData.append('files', file, skillRelativePath(file))
    }
    if (target.kind === 'personal') {
      formData.append('userIds', target.userIds.join(','))
    }

    sent = true
    const { data } = await api.post(target.kind === 'personal' ? '/admin/user-skills/upload' : '/skill-docs/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    if (target.kind === 'personal') {
      const names = (data?.skills || []).join(', ')
      const count = data?.users?.length || target.userIds.length
      ElMessage.success(names ? `已将 ${names} 添加到 ${count} 个用户` : `已添加到 ${count} 个用户`)
      await fetchPersonalSkills()
    } else {
      const names = data || []
      ElMessage.success(`Skills 上传成功：${names.join(', ')}`)
      await fetchSkillDocs()
    }
  } catch {
    // 拦截器已提示失败。个人技能可能已写入部分用户，刷新后列表才和磁盘一致。
    if (target.kind === 'personal' && sent) {
      await fetchPersonalSkills()
    }
  } finally {
    if (!options?.busyHeld) uploadBusy.value = false
  }
}

// ========== Delete ==========

async function handleDelete(row: any) {
  try {
    if (activeTab.value === 'personal') {
      await api.delete(`/admin/user-skills/${row.userId}/${encodeURIComponent(row.name)}`)
    } else {
      await api.delete(`/skill-docs/${row.name}`)
    }
    ElMessage.success(`Skill「${row.name}」已删除`)
    await fetchActiveTab()
    // 当前页删空时回退页码，避免停留在空白页
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (currentPage.value > maxPage) currentPage.value = maxPage
  } catch {
    // Error handled by interceptor
  }
}

onMounted(fetchActiveTab)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.skill-tabs {
  margin-bottom: 4px;
}

.search-form {
  margin-bottom: 16px;
}
.assign-form {
  margin-bottom: 12px;
}
.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
.upload-zone {
  border: 2px dashed var(--el-color-primary-light-3);
  border-radius: 8px;
  padding: 40px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--el-fill-color-blank);
}
.upload-zone:hover:not(.is-blocked),
.upload-zone.is-dragover:not(.is-blocked) {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.upload-zone.is-blocked {
  cursor: not-allowed;
}
.upload-icon {
  font-size: 48px;
  color: var(--el-color-primary);
  margin-bottom: 12px;
}
.upload-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-color-primary);
  margin-bottom: 8px;
}
.upload-hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.skill-detail p {
  margin: 8px 0;
}
.skill-body pre {
  background: var(--el-fill-color-light);
  padding: 16px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
}
</style>
