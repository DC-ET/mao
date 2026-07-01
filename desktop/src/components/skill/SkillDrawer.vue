<template>
  <el-drawer
    v-model="visible"
    title="我的技能"
    direction="rtl"
    size="420px"
    :before-close="handleClose"
  >
    <div class="skill-drawer-body">
      <!-- Upload area -->
      <div
        class="upload-zone"
        :class="{ 'is-dragover': isDragover }"
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
        <div class="upload-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div class="upload-text">拖拽或点击上传技能文件夹</div>
        <div class="upload-hint">上传个人技能，将在所有智能体中自动生效，每个文件夹必须包含 SKILL.md 文件</div>
      </div>

      <el-tabs v-model="activeTab" class="skill-tabs">
        <el-tab-pane label="已上传" name="uploaded">
          <div class="skill-list">
            <div v-if="loading" class="skill-empty">加载中...</div>
            <div v-else-if="skills.length === 0" class="skill-empty">暂无已上传技能</div>
            <div v-else class="skill-cards">
              <el-tooltip
                v-for="skill in skills"
                :key="skill.name"
                :content="skill.description || '暂无描述'"
                placement="left"
                :show-after="300"
              >
                <div class="skill-card">
                  <div class="skill-card-header">
                    <div class="skill-name">{{ skill.name }}</div>
                    <div class="skill-actions">
                      <template v-if="deletingName === skill.name">
                        <button class="skill-btn skill-btn-confirm-delete" @click="confirmDelete(skill)">
                          <el-icon :size="14"><Check /></el-icon>
                        </button>
                        <button class="skill-btn" @click="deletingName = null">
                          <el-icon :size="14"><Close /></el-icon>
                        </button>
                      </template>
                      <template v-else>
                        <el-tooltip content="查看内容" :show-after="300" placement="top">
                          <button class="skill-btn" @click="handleViewUploaded(skill)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                        </el-tooltip>
                        <el-tooltip content="删除" :show-after="300" placement="top">
                          <button class="skill-btn skill-btn-danger" @click="deletingName = skill.name">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </el-tooltip>
                      </template>
                    </div>
                  </div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                </div>
              </el-tooltip>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane v-if="isElectron" name="local">
          <template #label>
            <span>本地未上传</span>
            <el-badge
              v-if="pendingLocalSkills.length > 0"
              :value="pendingLocalSkills.length"
              class="local-tab-badge"
            />
          </template>

          <div class="local-skills-hint">
            来自 <code>{{ localSkillsDir }}</code>
            <button
              v-if="localSkillsDir"
              type="button"
              class="link-btn"
              @click="openLocalSkillsDir"
            >
              打开目录
            </button>
          </div>

          <div
            v-if="!localLoading && !localError && pendingLocalSkills.length > 0"
            class="local-skills-toolbar"
          >
            <button
              type="button"
              class="upload-all-btn"
              :disabled="uploadingAll || uploading"
              @click="uploadAllLocalSkills"
            >
              {{ uploadingAll ? '上传中...' : `一键全部上传 (${pendingLocalSkills.length})` }}
            </button>
          </div>

          <div class="skill-list">
            <div v-if="localLoading" class="skill-empty">扫描本地技能中...</div>
            <div v-else-if="localError" class="skill-empty skill-empty-error">{{ localError }}</div>
            <div v-else-if="pendingLocalSkills.length === 0" class="skill-empty">
              暂无待上传的本地技能
            </div>
            <div v-else class="skill-cards">
              <el-tooltip
                v-for="skill in pendingLocalSkills"
                :key="skill.folderName"
                :content="skill.description || '暂无描述'"
                placement="left"
                :show-after="300"
              >
                <div class="skill-card">
                  <div class="skill-card-header">
                    <div class="skill-name">{{ skill.name }}</div>
                    <div class="skill-actions">
                      <el-tooltip content="查看内容" :show-after="300" placement="top">
                        <button class="skill-btn" @click="handleViewLocal(skill)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      </el-tooltip>
                      <button
                        class="skill-upload-btn"
                        :disabled="uploadingAll || uploading || uploadingFolder === skill.folderName"
                        @click="uploadLocalSkill(skill)"
                      >
                        {{ uploadingFolder === skill.folderName ? '上传中...' : '上传' }}
                      </button>
                    </div>
                  </div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                </div>
              </el-tooltip>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- Skill detail dialog (on top of drawer) -->
    <el-dialog
      v-model="detailVisible"
      :title="`技能详情：${currentDoc?.name || ''}`"
      width="540px"
      append-to-body
    >
      <div v-if="currentDoc" class="skill-detail">
        <p><strong>描述：</strong>{{ currentDoc.description }}</p>
        <el-divider />
        <div class="skill-body markdown-body" v-html="renderedSkillBody"></div>
      </div>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Close } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useSkillDrawer } from '../../composables/useSkillDrawer'
import { renderMarkdown } from '../../composables/useMarkdown'

interface SkillDoc {
  name: string
  description: string
  folderPath: string
}

interface SkillDetail {
  name: string
  description: string
  body: string
  folderPath: string
  filePath: string
}

interface LocalSkillDoc {
  folderName: string
  name: string
  description: string
  folderPath: string
}

const { visible } = useSkillDrawer()

const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.listLocalSkills

const activeTab = ref('uploaded')
const loading = ref(false)
const localLoading = ref(false)
const skills = ref<SkillDoc[]>([])
const localSkills = ref<LocalSkillDoc[]>([])
const localSkillsDir = ref('')
const localError = ref('')
const detailVisible = ref(false)
const currentDoc = ref<SkillDetail | null>(null)
const renderedSkillBody = computed(() => renderMarkdown(currentDoc.value?.body ?? ''))
const isDragover = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadingAll = ref(false)
const uploadingFolder = ref<string | null>(null)
const deletingName = ref<string | null>(null)

const uploadedNameSet = computed(() => {
  const names = new Set<string>()
  for (const skill of skills.value) {
    names.add(skill.name)
  }
  return names
})

const pendingLocalSkills = computed(() => {
  return localSkills.value.filter((skill) => {
    return !uploadedNameSet.value.has(skill.name) && !uploadedNameSet.value.has(skill.folderName)
  })
})

watch(visible, (val) => {
  if (val) fetchAll()
})

async function fetchAll() {
  await Promise.all([fetchSkills(), fetchLocalSkills()])
}

async function fetchSkills() {
  loading.value = true
  try {
    const { data } = await api.get('/user-skills')
    skills.value = data || []
  } finally {
    loading.value = false
  }
}

async function fetchLocalSkills() {
  if (!isElectron) return

  localLoading.value = true
  localError.value = ''
  try {
    const result = await window.electronAPI.listLocalSkills()
    if (result.error) {
      localError.value = result.error
      localSkills.value = []
    } else {
      localSkills.value = result.skills || []
      localSkillsDir.value = result.skillsDir || ''
    }
  } catch (e: any) {
    localError.value = e?.message || '读取本地技能失败'
    localSkills.value = []
  } finally {
    localLoading.value = false
  }
}

async function handleViewUploaded(skill: SkillDoc) {
  try {
    const { data } = await api.get(`/user-skills/${skill.name}`)
    currentDoc.value = data
    detailVisible.value = true
  } catch {
    // Error handled by interceptor
  }
}

async function handleViewLocal(skill: LocalSkillDoc) {
  if (!isElectron) return
  try {
    const result = await window.electronAPI.getLocalSkillDetail(skill.folderName)
    if ('error' in result) {
      ElMessage.error(result.error)
      return
    }
    currentDoc.value = {
      name: result.name,
      description: result.description,
      body: result.body,
      folderPath: result.folderPath,
      filePath: result.filePath,
    }
    detailVisible.value = true
  } catch (e: any) {
    ElMessage.error(e?.message || '读取本地技能失败')
  }
}

async function confirmDelete(skill: SkillDoc) {
  try {
    await api.delete(`/user-skills/${skill.name}`)
    ElMessage.success(`技能「${skill.name}」已删除`)
    deletingName.value = null
    await fetchSkills()
  } catch {
    // Error handled by interceptor
  }
}

function openLocalSkillsDir() {
  if (localSkillsDir.value && window.electronAPI?.openFolder) {
    window.electronAPI.openFolder(localSkillsDir.value)
  }
}

function handleClose(done: () => void) {
  done()
}

// ========== Upload ==========

function triggerFileInput() {
  fileInputRef.value?.click()
}

function handleFileInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    uploadFiles(Array.from(input.files))
    input.value = ''
  }
}

function handleDrop(e: DragEvent) {
  isDragover.value = false
  const items = e.dataTransfer?.items
  if (!items) return

  const files: File[] = []
  const pending: Promise<void>[] = []

  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry) {
      pending.push(readEntryRecursive(entry, '', files))
    }
  }

  Promise.all(pending).then(() => {
    if (files.length > 0) {
      uploadFiles(files)
    }
  })
}

function readEntryRecursive(entry: FileSystemEntry, basePath: string, files: File[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry
      fileEntry.file((file) => {
        const relativePath = basePath ? `${basePath}/${file.name}` : file.name
        const newFile = new File([file], relativePath, { type: file.type })
        files.push(newFile)
        resolve()
      }, () => resolve())
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry
      const dirReader = dirEntry.createReader()
      const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name

      const readAll = (reader: FileSystemDirectoryReader, cb: (entries: FileSystemEntry[]) => void) => {
        reader.readEntries((entries) => {
          if (entries.length === 0) {
            cb([])
          } else {
            readAll(reader, (moreEntries) => {
              cb([...entries, ...moreEntries])
            })
          }
        }, () => cb([]))
      }

      readAll(dirReader, (entries) => {
        const childPromises = entries.map((child) => readEntryRecursive(child, dirPath, files))
        Promise.all(childPromises).then(() => resolve())
      })
    } else {
      resolve()
    }
  })
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function buildFilesForLocalSkill(skill: LocalSkillDoc): Promise<File[]> {
  const result = await window.electronAPI.readLocalSkillFiles(skill.folderName)
  if (result.error || !result.files?.length) {
    throw new Error(result.error || `技能「${skill.name}」未找到可上传的文件`)
  }

  return result.files.map((entry) => {
    const bytes = base64ToUint8Array(entry.base64)
    const relativePath = `${skill.folderName}/${entry.relativePath}`
    const blob = new Blob([bytes as BlobPart])
    return new File([blob], relativePath)
  })
}

async function uploadLocalSkill(skill: LocalSkillDoc) {
  if (!isElectron || uploading.value || uploadingAll.value || uploadingFolder.value) return

  uploadingFolder.value = skill.folderName
  try {
    const files = await buildFilesForLocalSkill(skill)
    await uploadFiles(files, { refreshLocal: true })
  } catch (e: any) {
    ElMessage.error(e?.message || '上传失败')
  } finally {
    uploadingFolder.value = null
  }
}

async function uploadAllLocalSkills() {
  if (!isElectron || uploading.value || uploadingAll.value) return

  const skills = [...pendingLocalSkills.value]
  if (skills.length === 0) return

  uploadingAll.value = true
  const succeeded: string[] = []
  const failed: string[] = []

  try {
    for (const skill of skills) {
      try {
        const files = await buildFilesForLocalSkill(skill)
        const ok = await uploadFiles(files, { silentSuccess: true })
        if (ok) {
          succeeded.push(skill.name)
        } else {
          failed.push(skill.name)
        }
      } catch {
        failed.push(skill.name)
      }
    }

    await fetchSkills()
    await fetchLocalSkills()

    if (succeeded.length === 0) {
      ElMessage.error('全部上传失败')
    } else if (failed.length > 0) {
      ElMessage.warning(`已上传 ${succeeded.length} 个技能，失败：${failed.join(', ')}`)
    } else {
      ElMessage.success(`已全部上传 ${succeeded.length} 个技能`)
      activeTab.value = 'uploaded'
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '批量上传失败')
  } finally {
    uploadingAll.value = false
  }
}

async function uploadFiles(files: File[], options?: { refreshLocal?: boolean; silentSuccess?: boolean }): Promise<boolean> {
  if (uploading.value) return false
  uploading.value = true

  const formData = new FormData()
  for (const file of files) {
    const relativePath = (file as any).webkitRelativePath || file.name
    formData.append('files', file, relativePath)
  }

  try {
    const { data } = await api.post('/user-skills/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    const names = data || []
    if (!options?.silentSuccess) {
      ElMessage.success(`技能上传成功：${names.join(', ')}`)
    }
    await fetchSkills()
    if (options?.refreshLocal) {
      await fetchLocalSkills()
      if (pendingLocalSkills.value.length === 0) {
        activeTab.value = 'uploaded'
      }
    }
    return true
  } catch {
    // Error handled by interceptor
    return false
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.skill-drawer-body {
  padding: 0 4px;
}

.upload-zone {
  border: 2px dashed var(--aw-divider);
  border-radius: 8px;
  padding: 16px 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 16px;
  background: var(--aw-surface-code);
}

.upload-zone:hover,
.upload-zone.is-dragover {
  border-color: var(--aw-primary);
}

.upload-icon {
  color: var(--aw-ink-muted);
  margin-bottom: 6px;
}

.upload-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--aw-ink);
  margin-bottom: 4px;
}

.upload-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.skill-tabs {
  margin-top: 4px;
}

.skill-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}

.skill-tabs :deep(.el-tabs__item) {
  font-size: 13px;
  height: 32px;
  line-height: 32px;
  padding: 0 12px;
}

.skill-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
}

.local-tab-badge {
  margin-left: 4px;
}

.local-tab-badge :deep(.el-badge__content) {
  font-size: 10px;
  height: 14px;
  line-height: 14px;
  padding: 0 4px;
  transform: translateY(-1px) scale(0.9);
}

.local-skills-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.local-skills-hint code {
  font-size: 11px;
  background: var(--aw-surface-code);
  padding: 1px 4px;
  border-radius: 4px;
}

.link-btn {
  margin-left: 8px;
  border: none;
  background: none;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.link-btn:hover {
  text-decoration: underline;
}

.local-skills-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}

.upload-all-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.upload-all-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.upload-all-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.skill-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.skill-empty-error {
  color: var(--aw-danger);
}

.skill-cards {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.skill-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 5px 10px;
  transition: border-color 0.15s;
}

.skill-card:hover {
  border-color: var(--aw-divider);
}

.skill-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.skill-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.skill-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted);
  transition: color 0.15s, background 0.15s;
}

.skill-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.skill-btn-danger:hover {
  color: var(--aw-danger);
}

.skill-btn-confirm-delete {
  color: var(--aw-danger);
}

.skill-upload-btn {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.skill-upload-btn:hover:not(:disabled) {
  background: var(--aw-primary);
  color: #fff;
}

.skill-upload-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.skill-desc {
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-detail p {
  margin: 8px 0;
  font-size: 13px;
  color: var(--aw-ink);
}

.skill-body {
  padding: 16px;
  border-radius: 8px;
  background: var(--aw-surface-code);
  max-height: 400px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aw-ink);
}

.skill-body :deep(h1),
.skill-body :deep(h2),
.skill-body :deep(h3),
.skill-body :deep(h4) {
  font-weight: 600;
  color: var(--aw-ink);
  margin: 12px 0 6px;
}

.skill-body :deep(h1) { font-size: 16px; }
.skill-body :deep(h2) { font-size: 14px; }
.skill-body :deep(h3),
.skill-body :deep(h4) { font-size: 13px; }

.skill-body :deep(p) {
  margin: 0 0 8px;
}

.skill-body :deep(a) {
  color: var(--aw-primary);
  text-decoration: none;
}

.skill-body :deep(a:hover) {
  text-decoration: underline;
}

.skill-body :deep(code) {
  font-family: var(--aw-font-mono);
}

.skill-body :deep(pre) {
  margin: 8px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.skill-body :deep(.code-block) {
  margin: 8px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.skill-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--aw-surface-code-header);
  font-size: 11px;
}

.skill-body :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
}

.skill-body :deep(.code-copy-btn) {
  border: none;
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--aw-radius-xs);
}

.skill-body :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.skill-body :deep(.hljs) {
  padding: 12px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.skill-body :deep(ul),
.skill-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.skill-body :deep(li) {
  margin: 2px 0;
}

.skill-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-border);
  color: var(--aw-ink-muted);
}

.skill-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}

.skill-body :deep(th),
.skill-body :deep(td) {
  border: 1px solid var(--aw-border);
  padding: 6px 10px;
  text-align: left;
}

.skill-body :deep(th) {
  background: var(--aw-surface-hover);
  font-weight: 600;
}

.skill-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-border);
  margin: 12px 0;
}
</style>
