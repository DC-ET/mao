<template>
  <section class="doc-viewer">
    <div class="viewer-toolbar">
      <div class="viewer-title" :title="titleText">{{ titleText }}</div>
      <div class="viewer-actions">
        <template v-if="mode !== 'edit'">
          <el-button size="small" :type="mode === 'render' ? 'primary' : 'default'" @click="mode = 'render'">渲染态</el-button>
          <el-button size="small" :type="mode === 'source' ? 'primary' : 'default'" @click="mode = 'source'">源码态</el-button>
          <el-button v-if="payload.kind === 'doc' && canWrite" size="small" @click="startEdit">编辑</el-button>
        </template>
        <el-button size="small" aria-label="关闭阅读器" @click="store.closeViewer()">关闭</el-button>
      </div>
    </div>

    <div v-if="store.viewerLoading" class="viewer-loading" v-loading="true" element-loading-text="加载中" />

    <template v-else>
      <!-- 元数据卡（单篇经验） -->
      <div v-if="payload.kind === 'doc' && payload.meta" class="meta-card">
        <div class="meta-row">
          <span class="meta-label">文件名</span>
          <span class="meta-value">{{ payload.fileName }}</span>
        </div>
        <div v-if="payload.meta.summary" class="meta-row">
          <span class="meta-label">摘要</span>
          <span class="meta-value">{{ payload.meta.summary }}</span>
        </div>
        <div v-if="payload.meta.applicable" class="meta-row">
          <span class="meta-label">适用</span>
          <span class="meta-value">{{ payload.meta.applicable }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">关键词</span>
          <span class="meta-value meta-tags">
            <template v-if="tags.length > 0">
              <el-tag v-for="t in tags" :key="t" size="small" class="meta-tag" @click="store.setTag(t)">{{ t }}</el-tag>
            </template>
            <span v-else>—</span>
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-label">最后验证</span>
          <span class="meta-value">
            {{ payload.meta.lastVerified || '—' }}
            <el-tag v-if="staleVerified" size="small" type="info">久未验证</el-tag>
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-label">更新</span>
          <span class="meta-value">{{ formatDateTime(payload.meta.updatedAt) }} · {{ formatSize(payload.meta.sizeBytes) }}</span>
        </div>
      </div>
      <div v-else-if="payload.kind === 'index'" class="meta-card index-hint">
        INDEX.md 由系统自动生成，请勿手改；共 {{ indexDocCount }} 篇记录。Agent 按「文件名 | 标题 | 关键词 | 摘要 | 验证日期」一行一条检索。
      </div>

      <!-- 编辑态（新建 / 编辑） -->
      <div v-if="mode === 'edit' && editing" class="editor">
        <div class="editor-head">
          <el-input
            v-model="editing.fileName"
            :disabled="editing.existing"
            :placeholder="createPlaceholder"
            class="editor-name"
            aria-label="经验文件名"
          />
          <div class="editor-actions">
            <el-button size="small" type="primary" :loading="saving" @click="submitSave">保存</el-button>
            <el-button size="small" @click="cancelEdit">取消</el-button>
          </div>
        </div>
        <el-input
          v-model="editing.content"
          type="textarea"
          :rows="16"
          placeholder="---&#10;title: 标题&#10;keywords: 关键词, 逗号分隔&#10;summary: 一句话摘要&#10;applicable: 适用范围&#10;last_verified: YYYY-MM-DD&#10;---&#10;&#10;正文（现象 / 排查 / 根因 / 解法 / 验证）"
          aria-label="经验文档内容"
        />
      </div>

      <!-- 阅读态 -->
      <template v-else>
        <div v-if="mode === 'render'" class="markdown-body markdown-doc doc-content" v-html="rendered" />
        <pre v-else class="source-pre">{{ payload.content }}</pre>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from '../../session/composables/useMarkdown'
import { formatDateTime } from '../../../utils/datetime'
import { useAuthStore } from '../../../stores/auth'
import '../../../styles/markdown-doc.css'
import { EXPERIENCE_LIBRARY_KEY, type ViewerPayload } from '../composables/useExperienceLibrary'
import { formatSize, isStaleVerified, splitKeywords, stripFrontmatter } from '../experience-format'

const props = defineProps<{ payload: ViewerPayload }>()

const store = inject(EXPERIENCE_LIBRARY_KEY)!
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

const mode = ref<'render' | 'source' | 'edit'>('render')
const editing = ref<{ fileName: string; content: string; existing: boolean } | null>(null)
const saving = ref(false)

// 索引记录条数：从索引头 count 注释解析（与后端 readIndexCount 同口径），缺失按 0 展示
const indexDocCount = computed(() => {
  if (props.payload.kind !== 'index') return 0
  const match = /<!-- count: (\d+) -->/.exec(props.payload.content)
  return match ? Number(match[1]) : 0
})

const titleText = computed(() => {
  const v = props.payload
  if (v.kind === 'index') return '索引 INDEX.md（系统自动生成）'
  if (v.kind === 'create') return '新建经验'
  return v.meta?.title || v.fileName
})

const tags = computed(() => (props.payload.kind === 'doc' ? splitKeywords(props.payload.meta?.keywords ?? '') : []))
const staleVerified = computed(() => props.payload.kind === 'doc' && isStaleVerified(props.payload.meta?.lastVerified ?? ''))

const rendered = computed(() => renderMarkdown(stripFrontmatter(props.payload.content)))

// 新建占位文件名：今日日期前缀 + 主题待填
const createPlaceholder = (() => {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${today}-主题.md`
})()

// 每次打开新载荷（文档/索引/新建）重置视图态与编辑缓冲
watch(() => props.payload, (v) => {
  mode.value = v.kind === 'create' ? 'edit' : v.initialMode
  if (v.kind === 'create') {
    editing.value = { fileName: '', content: v.content, existing: false }
  } else if (v.kind === 'doc' && v.initialMode === 'edit') {
    // 行内「编辑」入口：载荷带 initialMode='edit'，须同步初始化编辑缓冲（否则编辑器模板因 editing 为空不渲染）
    editing.value = { fileName: v.fileName, content: v.content, existing: true }
  } else {
    editing.value = null
  }
}, { immediate: true })

function startEdit(): void {
  if (props.payload.kind !== 'doc') return
  editing.value = { fileName: props.payload.fileName, content: props.payload.content, existing: true }
  mode.value = 'edit'
}

function cancelEdit(): void {
  editing.value = null
  if (props.payload.kind === 'create') {
    store.closeViewer()
  } else {
    mode.value = 'render'
  }
}

async function submitSave(): Promise<void> {
  if (editing.value == null) return
  const fileName = editing.value.fileName.trim()
  const content = editing.value.content
  if (!editing.value.existing) {
    // 空文件名 + 占位指引（预填残缺占位名曾被原样保存入库，沿用旧弹窗约束）
    if (fileName === '') {
      ElMessage.warning('请输入文件名')
      return
    }
    if (!fileName.endsWith('.md') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      ElMessage.warning('文件名必须是 .md 结尾且不含路径')
      return
    }
  }
  // 后端 PUT 现状放行空串（校验只判 null）：前端收口，空内容不允许保存
  if (content.trim() === '') {
    ElMessage.warning('正文不能为空')
    return
  }
  saving.value = true
  try {
    const ok = await store.saveDoc(fileName, content, editing.value.existing)
    if (ok) {
      editing.value = null
      // 保存成功：saveDoc 已刷新右栏载荷，视图态随载荷重置回渲染态
    }
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.doc-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 320px;
}
.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.viewer-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
}
.viewer-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0;
}
.viewer-actions :deep(.el-button + .el-button) {
  margin-left: 8px;
}
.viewer-loading {
  min-height: 200px;
}
.meta-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 13px;
}
.meta-card.index-hint {
  color: var(--el-text-color-secondary);
}
.meta-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.meta-label {
  flex-shrink: 0;
  width: 60px;
  color: var(--el-text-color-secondary);
}
.meta-value {
  min-width: 0;
}
.meta-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.meta-tag {
  cursor: pointer;
}
.doc-content {
  color: var(--el-text-color-primary);
}
.source-pre {
  margin: 0;
  padding: 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 480px;
  overflow: auto;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.editor-head {
  display: flex;
  gap: 8px;
}
.editor-name {
  max-width: 360px;
}
.editor-actions {
  display: flex;
  gap: 8px;
}
.editor-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
