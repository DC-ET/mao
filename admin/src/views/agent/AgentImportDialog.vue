<template>
  <el-dialog
    :model-value="true"
    title="导入 Agent Bundle"
    width="760px"
    :close-on-click-modal="false"
    @update:model-value="emit('close')"
  >
    <div class="import-body">
      <el-alert type="warning" :closable="false" class="import-tip">
        bundle 来自其它 Mao 实例或社区分享。导入前请核对预检报告中的提示词全文与 MCP 定义；
        MCP 将以<b>停用</b>状态创建，需在 MCP 管理页补齐环境变量并手动启用后才会生效。
      </el-alert>

      <el-upload
        :auto-upload="false"
        :show-file-list="false"
        accept=".json,application/json"
        :on-change="handleFileChange"
      >
        <el-button type="primary" plain>选择 bundle JSON 文件</el-button>
        <span v-if="fileName" class="file-name">{{ fileName }}</span>
      </el-upload>

      <div v-if="report" v-loading="committing" class="report">
        <el-descriptions :column="2" border size="small" class="report-desc">
          <el-descriptions-item label="Bundle 内名称">{{ report.agentName }}</el-descriptions-item>
          <el-descriptions-item label="导入后名称">
            {{ report.finalName }}
            <el-tag v-if="report.nameConflict" type="warning" size="small">名称冲突已加后缀</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="经验">{{ report.experiencesCount }} 条</el-descriptions-item>
          <el-descriptions-item label="推荐问题">{{ report.suggestedQuestionsCount }} 条</el-descriptions-item>
        </el-descriptions>

        <el-collapse class="report-collapse">
          <el-collapse-item title="角色定义（systemPrompt）全文">
            <pre class="prompt-pre">{{ report.systemPrompt }}</pre>
          </el-collapse-item>
        </el-collapse>

        <h4 class="section-title">技能</h4>
        <el-table :data="report.skills" size="small" border>
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="include" label="方式" width="90">
            <template #default="{ row }">{{ row.include === 'inline' ? '内联' : '引用' }}</template>
          </el-table-column>
          <el-table-column label="动作" width="150">
            <template #default="{ row }">
              <el-tag :type="skillActionType(row.action)" size="small">{{ skillActionLabel(row.action) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="说明" min-width="180" show-overflow-tooltip />
        </el-table>

        <h4 class="section-title">MCP 服务器</h4>
        <el-table :data="report.mcpServers" size="small" border>
          <el-table-column prop="name" label="名称" min-width="120" />
          <el-table-column prop="serverType" label="类型" width="80" />
          <el-table-column label="动作" width="170">
            <template #default="{ row }">
              <el-tag :type="mcpActionType(row.action)" size="small">{{ mcpActionLabel(row.action) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column type="expand">
            <template #default="{ row }">
              <pre class="definition-pre">{{ JSON.stringify(row.definition, null, 2) }}</pre>
            </template>
          </el-table-column>
        </el-table>

        <template v-if="report.warnings.length > 0">
          <h4 class="section-title">警告</h4>
          <el-alert
            v-for="(warning, index) in report.warnings"
            :key="index"
            :title="warning"
            type="warning"
            :closable="false"
            class="warning-item"
          />
        </template>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button
        v-if="report && !imported"
        type="primary"
        :loading="committing"
        @click="handleConfirm"
      >确认导入</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { api } from '../../api'

interface BundleImportReport {
  agentName: string
  finalName: string
  nameConflict: boolean
  systemPrompt: string
  experiencesCount: number
  suggestedQuestionsCount: number
  skills: Array<{ name: string; include: 'inline' | 'reference'; action: string; detail?: string }>
  mcpServers: Array<{ name: string; serverType: string; action: string; definition: unknown }>
  warnings: string[]
}

const emit = defineEmits<{
  close: []
  saved: []
}>()

const fileName = ref('')
const bundle = ref<unknown>(null)
const report = ref<BundleImportReport | null>(null)
const committing = ref(false)
const imported = ref(false)
// 换文件时旧预检响应可能晚归：序号守卫，只展示最后一次请求的结果
let precheckSeq = 0

async function handleFileChange(file: UploadFile) {
  const raw = file.raw
  if (raw == null) return
  report.value = null
  imported.value = false
  let parsedBundle: unknown
  try {
    parsedBundle = JSON.parse(await raw.text())
  } catch {
    ElMessage.error('文件不是合法 JSON')
    return
  }
  bundle.value = parsedBundle
  fileName.value = raw.name
  const seq = ++precheckSeq
  committing.value = true
  try {
    const { data } = await api.post<BundleImportReport>('/agent-bundle/import', { bundle: parsedBundle, confirm: false })
    if (seq !== precheckSeq) return
    report.value = data
  } catch {
    // 拦截器已提示
  } finally {
    if (seq === precheckSeq) committing.value = false
  }
}

async function handleConfirm() {
  if (bundle.value == null || committing.value) return
  committing.value = true
  try {
    const { data } = await api.post<{ agentId: number; report: BundleImportReport }>(
      '/agent-bundle/import',
      { bundle: bundle.value, confirm: true }
    )
    report.value = data.report
    imported.value = true
    ElMessage.success(`导入完成：${data.report.finalName}`)
    emit('saved')
  } catch {
    // 拦截器已提示
  } finally {
    committing.value = false
  }
}

function skillActionLabel(action: string): string {
  const map: Record<string, string> = {
    'system-exists': '系统技能已存在',
    'will-import': '将导入',
    'import-failed': '导入失败',
    'exists-skip': '同名跳过（不覆盖）',
    ok: '已就绪',
    missing: '目标实例缺失',
  }
  return map[action] ?? action
}

function skillActionType(action: string): 'success' | 'warning' | 'danger' | 'info' {
  if (action === 'will-import' || action === 'ok' || action === 'system-exists') return 'success'
  if (action === 'exists-skip') return 'warning'
  if (action === 'import-failed') return 'danger'
  return action === 'missing' ? 'warning' : 'info'
}

function mcpActionLabel(action: string): string {
  const map: Record<string, string> = {
    'will-create-disabled': '将创建（停用态）',
    'skip-name-conflict': '同名跳过（不绑定）',
    'skip-invalid': '定义无效跳过',
  }
  return map[action] ?? action
}

function mcpActionType(action: string): 'success' | 'warning' | 'danger' | 'info' {
  if (action === 'will-create-disabled') return 'success'
  if (action === 'skip-name-conflict') return 'warning'
  if (action === 'skip-invalid') return 'danger'
  return 'info'
}
</script>

<style scoped>
.import-tip {
  margin-bottom: 14px;
}
.file-name {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
}
.report {
  margin-top: 16px;
}
.report-desc {
  margin-bottom: 12px;
}
.report-collapse {
  margin-bottom: 12px;
}
.section-title {
  margin: 14px 0 8px;
}
.prompt-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
  font-family: inherit;
  line-height: 1.6;
}
.definition-pre {
  margin: 0;
  padding: 8px 12px;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: var(--el-fill-color-light);
}
.warning-item {
  margin-bottom: 8px;
}
</style>
