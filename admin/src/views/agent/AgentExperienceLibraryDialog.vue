<template>
  <ResponsiveDialog
    :model-value="true"
    :title="`${agentName} · 团队经验库`"
    width="960px"
    :close-on-click-modal="false"
    @update:model-value="!$event && emit('close')"
  >
    <el-alert
      title="经验库存放于服务器共享目录（跨会话、跨成员）。Agent 在 CLOUD 会话中通过工作区的 团队经验/ 目录读写；INDEX.md 由系统自动生成，请勿手改。"
      type="info"
      :closable="false"
      show-icon
    />

    <div class="library-toolbar">
      <div class="switch-wrap">
        <span class="switch-label">启用团队经验库</span>
        <el-switch :model-value="enabled" :loading="toggling" :disabled="!canWrite" @change="toggleEnabled" />
        <span class="switch-hint">{{ enabled ? 'CLOUD 会话挂载 团队经验/ 并注入路标' : '不挂载、不注入提示词；文档仍可在此维护' }}</span>
      </div>
      <div class="toolbar-actions">
        <el-button size="small" :disabled="loading" @click="load">刷新</el-button>
        <el-button size="small" type="primary" :disabled="!canWrite" @click="startCreate">新建经验</el-button>
        <el-button size="small" :disabled="!canWrite || rebuilding" :loading="rebuilding" @click="rebuildIndex">重建索引</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="docs" max-height="300" size="small">
      <el-table-column prop="fileName" label="文件名" min-width="230" show-overflow-tooltip />
      <el-table-column prop="title" label="标题" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.title || '—' }}</template>
      </el-table-column>
      <el-table-column prop="keywords" label="关键词" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.keywords || '—' }}</template>
      </el-table-column>
      <el-table-column label="最后验证" width="110">
        <template #default="{ row }">{{ row.lastVerified || '—' }}</template>
      </el-table-column>
      <el-table-column label="大小" width="90" align="right">
        <template #default="{ row }">{{ formatSize(row.sizeBytes) }}</template>
      </el-table-column>
      <el-table-column prop="updatedAt" label="更新时间" width="170" :formatter="formatDateTimeColumn" />
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" :disabled="!canWrite" @click="startEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" :disabled="!canWrite" @click="removeDoc(row)">删除</el-button>
        </template>
        <template #empty>暂无经验文档；Agent 完成复杂任务后会自行沉淀，也可在此新建</template>
      </el-table-column>
    </el-table>

    <div v-if="editing" class="editor">
      <div class="editor-head">
        <el-input
          v-model="editing.fileName"
          :disabled="editing.existing"
          placeholder="文件名，如 2026-10-24-mysql-deadlock.md"
          class="editor-name"
          aria-label="经验文件名"
        />
        <div class="editor-actions">
          <el-button size="small" :loading="saving" type="primary" @click="saveDoc">保存</el-button>
          <el-button size="small" @click="editing = null">取消</el-button>
        </div>
      </div>
      <el-input
        v-model="editing.content"
        type="textarea"
        :rows="12"
        placeholder="---\ntitle: 标题\nkeywords: 关键词, 逗号分隔\nsummary: 一句话摘要\napplicable: 适用范围\nlast_verified: YYYY-MM-DD\n---\n\n正文（现象 / 排查 / 根因 / 解法 / 验证）"
        aria-label="经验文档内容"
      />
    </div>

    <el-collapse class="index-preview">
      <el-collapse-item title="索引原文（INDEX.md，自动生成）" name="index">
        <pre class="index-pre">{{ indexContent || '（暂无）' }}</pre>
      </el-collapse-item>
    </el-collapse>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTimeColumn } from '../../utils/datetime'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface ExperienceDoc {
  fileName: string
  title: string
  keywords: string
  summary: string
  applicable: string
  lastVerified: string
  sizeBytes: number
  updatedAt: string
}

interface LibraryOverview {
  enabled: boolean
  docs: ExperienceDoc[]
  indexContent: string
}

const props = defineProps<{ agentId: number; agentName: string; initialEnabled: boolean; canWrite: boolean }>()
const emit = defineEmits<{ close: []; 'toggle-enabled': [boolean] }>()

const enabled = ref(props.initialEnabled)
const docs = ref<ExperienceDoc[]>([])
const indexContent = ref('')
const loading = ref(false)
const toggling = ref(false)
const rebuilding = ref(false)
const saving = ref(false)
const editing = ref<{ fileName: string; content: string; existing: boolean } | null>(null)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get<LibraryOverview>(`/agents/${props.agentId}/experience-library/docs`)
    enabled.value = data.enabled
    docs.value = data.docs
    indexContent.value = data.indexContent
  } catch {
    ElMessage.error('加载经验库失败')
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(next: string | number | boolean) {
  toggling.value = true
  try {
    const { data } = await api.patch<{ enabled: boolean }>(`/agents/${props.agentId}/experience-library`, { enabled: !!next })
    enabled.value = data.enabled
    emit('toggle-enabled', data.enabled)
    ElMessage.success(data.enabled ? '已启用团队经验库' : '已停用团队经验库')
  } catch {
    // 失败保持原状态（el-switch 用 :model-value 受控渲染，无需回滚）
  } finally {
    toggling.value = false
  }
}

function startCreate() {
  const today = new Date().toISOString().slice(0, 10)
  editing.value = { fileName: `${today}-.md`, content: '', existing: false }
}

async function startEdit(row: ExperienceDoc) {
  try {
    const { data } = await api.get<{ fileName: string; content: string }>(
      `/agents/${props.agentId}/experience-library/docs/content`,
      { params: { file: row.fileName } },
    )
    editing.value = { fileName: data.fileName, content: data.content, existing: true }
  } catch {
    ElMessage.error('读取经验文档失败')
  }
}

async function saveDoc() {
  if (!editing.value) return
  const fileName = editing.value.fileName.trim()
  if (!fileName.endsWith('.md') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    ElMessage.warning('文件名必须是 .md 结尾且不含路径')
    return
  }
  saving.value = true
  try {
    await api.put(`/agents/${props.agentId}/experience-library/docs/content`, {
      fileName,
      content: editing.value.content,
    })
    ElMessage.success('已保存')
    editing.value = null
    await load()
  } catch {
    // api 拦截器已弹错误提示
  } finally {
    saving.value = false
  }
}

async function removeDoc(row: ExperienceDoc) {
  try {
    await ElMessageBox.confirm(`确定删除「${row.title || row.fileName}」吗？该操作不可恢复。`, '删除经验', { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.delete(`/agents/${props.agentId}/experience-library/docs`, { params: { file: row.fileName } })
    ElMessage.success('已删除')
    await load()
  } catch {
    // api 拦截器已弹错误提示
  }
}

async function rebuildIndex() {
  rebuilding.value = true
  try {
    await api.post(`/agents/${props.agentId}/experience-library/index/rebuild`)
    ElMessage.success('索引已重建')
    await load()
  } catch {
    // api 拦截器已弹错误提示
  } finally {
    rebuilding.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.library-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.switch-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.switch-label {
  font-weight: 600;
}
.switch-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
}
.editor {
  margin-top: 12px;
}
.editor-head {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.editor-name {
  max-width: 360px;
}
.editor-actions {
  display: flex;
  gap: 8px;
}
.index-preview {
  margin-top: 12px;
}
.index-pre {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
}
</style>
