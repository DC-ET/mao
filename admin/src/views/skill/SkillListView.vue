<template>
  <div class="skill-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent Skills</span>
          <el-tag type="info" size="small">按 Anthropic 规范管理目录包 Skill，每个包必须包含顶层 SKILL.md。</el-tag>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键词">
          <el-input
            v-model="keyword"
            clearable
            placeholder="名称 / 描述"
            style="width: 220px"
          />
        </el-form-item>
      </el-form>

      <!-- Upload area -->
      <div
        class="upload-zone"
        :class="{ 'is-dragover': isDragover }"
        v-loading="uploading"
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
        <div class="upload-hint">可一次选择或拖入一个或多个包含 SKILL.md 的目录。</div>
      </div>

      <!-- Skill table -->
      <el-table :data="filteredSkillDocs" v-loading="loading" stripe style="margin-top: 16px">
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column prop="description" label="描述" min-width="300" show-overflow-tooltip />
        <el-table-column label="校验" width="90">
          <template #default="{ row }">
            <el-tag :type="row.filePath || row.folderPath ? 'success' : 'danger'" size="small">
              {{ row.filePath || row.folderPath ? '通过' : '异常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关联 Agent" width="110" align="right">
          <template #default="{ row }">{{ relatedAgentCount(row.name) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default>
            <el-tag type="success" size="small">可用</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="folderPath" label="路径" min-width="250" show-overflow-tooltip />
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
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Skill content dialog -->
    <el-dialog
      v-model="detailVisible"
      :title="`Skill: ${currentDoc?.name || ''}`"
      width="700px"
    >
      <div v-if="currentDoc" class="skill-detail">
        <p><strong>描述：</strong>{{ currentDoc.description }}</p>
        <p><strong>文件路径：</strong>{{ currentDoc.filePath }}</p>
        <el-divider />
        <div class="skill-body">
          <pre>{{ currentDoc.body }}</pre>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { api } from '../../api'

const loading = ref(false)
const skillDocs = ref<any[]>([])
const agents = ref<any[]>([])
const keyword = ref('')
const detailVisible = ref(false)
const currentDoc = ref<any>(null)
const isDragover = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

async function fetchSkillDocs() {
  loading.value = true
  try {
    const [{ data }, agentRes] = await Promise.all([
      api.get('/skill-docs'),
      api.get('/agents')
    ])
    skillDocs.value = data || []
    agents.value = agentRes.data || []
  } finally {
    loading.value = false
  }
}

const filteredSkillDocs = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return skillDocs.value
  return skillDocs.value.filter(doc =>
    `${doc.name || ''} ${doc.description || ''}`.toLowerCase().includes(kw))
})

function relatedAgentCount(skillName: string) {
  return agents.value.filter(agent => (agent.skillNames || []).includes(skillName)).length
}

async function handleView(row: any) {
  try {
    const { data } = await api.get(`/skill-docs/${row.name}`)
    currentDoc.value = data
    detailVisible.value = true
  } catch {
    // Error handled by interceptor
  }
}

// ========== Upload ==========

function triggerFileInput() {
  fileInputRef.value?.click()
}

function handleFileInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    uploadFiles(Array.from(input.files))
    input.value = '' // reset so same folder can be selected again
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
        // Preserve the directory structure relative to the dropped root
        const relativePath = basePath ? `${basePath}/${file.name}` : file.name
        // Create a new File with the correct relative path
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
            // Keep reading until empty
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
    // webkitRelativePath preserves the folder structure, e.g. "bigdata-cli/SKILL.md"
    const relativePath = (file as any).webkitRelativePath || file.name
    formData.append('files', file, relativePath)
  }

  try {
    const { data } = await api.post('/skill-docs/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    const names = data || []
    ElMessage.success(`Skills 上传成功：${names.join(', ')}`)
    await fetchSkillDocs()
  } catch {
    // Error handled by interceptor
  } finally {
    uploading.value = false
  }
}

// ========== Delete ==========

async function handleDelete(row: any) {
  try {
    await api.delete(`/skill-docs/${row.name}`)
    ElMessage.success(`Skill「${row.name}」已删除`)
    await fetchSkillDocs()
  } catch {
    // Error handled by interceptor
  }
}

onMounted(fetchSkillDocs)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  margin-bottom: 16px;
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
.upload-zone:hover,
.upload-zone.is-dragover {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
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
