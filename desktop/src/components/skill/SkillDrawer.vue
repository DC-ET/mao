<template>
  <el-drawer
    v-model="visible"
    title="我的技能"
    direction="rtl"
    size="420px"
    :before-close="handleClose"
  >
    <div class="skill-drawer-body">
      <p class="skill-subtitle">上传个人技能，将在所有智能体中自动生效。</p>

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
        <div class="upload-hint">每个文件夹必须包含 SKILL.md 文件</div>
      </div>

      <!-- Skill list -->
      <div class="skill-list">
        <div v-if="loading" class="skill-empty">加载中...</div>
        <div v-else-if="skills.length === 0" class="skill-empty">暂无个人技能</div>
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
                    <button class="skill-btn" @click="handleView(skill)">
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
        <pre class="skill-body">{{ currentDoc.body }}</pre>
      </div>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Close } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useSkillDrawer } from '../../composables/useSkillDrawer'

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

const { visible } = useSkillDrawer()

const loading = ref(false)
const skills = ref<SkillDoc[]>([])
const detailVisible = ref(false)
const currentDoc = ref<SkillDetail | null>(null)
const isDragover = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const deletingName = ref<string | null>(null)

watch(visible, (val) => {
  if (val) fetchSkills()
})

async function fetchSkills() {
  loading.value = true
  try {
    const { data } = await api.get('/user-skills')
    skills.value = data || []
  } finally {
    loading.value = false
  }
}

async function handleView(skill: SkillDoc) {
  try {
    const { data } = await api.get(`/user-skills/${skill.name}`)
    currentDoc.value = data
    detailVisible.value = true
  } catch {
    // Error handled by interceptor
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

async function uploadFiles(files: File[]) {
  if (uploading.value) return
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
    ElMessage.success(`技能上传成功：${names.join(', ')}`)
    await fetchSkills()
  } catch {
    // Error handled by interceptor
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.skill-drawer-body {
  padding: 0 4px;
}

.skill-subtitle {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0 0 20px 0;
}

.upload-zone {
  border: 2px dashed var(--aw-divider);
  border-radius: 8px;
  padding: 24px 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 20px;
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

.skill-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
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
}

.skill-actions {
  display: flex;
  gap: 2px;
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
  background: var(--aw-surface-code);
  padding: 16px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aw-ink);
}
</style>
