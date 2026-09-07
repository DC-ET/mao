<template>
  <ResponsiveDialog
    :model-value="true"
    :title="`${agentName} · 系统提示词版本`"
    width="900px"
    :close-on-click-modal="!rollingBack"
    :close-on-press-escape="!rollingBack"
    :show-close="!rollingBack"
    @update:model-value="!$event && emit('close')"
  >
    <el-alert
      title="仅恢复系统提示词，不影响名称、经验、Skills、MCP 或默认模型。回滚会保留历史并生成新版本。"
      type="info"
      :closable="false"
      show-icon
    />
    <div v-loading="loading" class="history-content">
      <el-table :data="versions" max-height="280" highlight-current-row @current-change="selectVersion">
        <el-table-column label="版本" width="120">
          <template #default="{ row }">
            v{{ row.version }}
            <el-tag v-if="row.version === currentVersion" size="small">当前</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="保存时间" min-width="180" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作人 ID" width="110">
          <template #default="{ row }">{{ row.operatorId ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="来源" min-width="130">
          <template #default="{ row }">{{ row.sourceVersion ? `回滚自 v${row.sourceVersion}` : '保存' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button link type="primary" @click="selected = row">预览</el-button>
          </template>
        </el-table-column>
        <template #empty>{{ loadFailed ? '加载失败，请重试' : '暂无版本记录' }}</template>
      </el-table>
      <template v-if="selected">
        <h4>v{{ selected.version }} · 系统提示词预览</h4>
        <el-input :model-value="selected.systemPrompt" type="textarea" :rows="12" readonly aria-label="系统提示词版本预览" />
      </template>
    </div>
    <template #footer>
      <el-button :disabled="loading || rollingBack" @click="loadVersions">刷新</el-button>
      <el-button :disabled="rollingBack" @click="emit('close')">关闭</el-button>
      <el-button
        type="warning"
        :loading="rollingBack"
        :disabled="loading || !selected || selected.version === currentVersion"
        @click="rollback"
      >回滚到此版本</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTimeColumn } from '../../utils/datetime'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface PromptVersion {
  id: number
  agentId: number
  version: number
  systemPrompt: string
  operatorId: number | null
  sourceVersion: number | null
  createdAt: string
}

const props = defineProps<{ agentId: number; agentName: string }>()
const emit = defineEmits<{ close: []; restored: [] }>()
const versions = ref<PromptVersion[]>([])
const selected = ref<PromptVersion | null>(null)
const currentVersion = computed(() => versions.value[0]?.version)
const loading = ref(false)
const loadFailed = ref(false)
const rollingBack = ref(false)

function selectVersion(row: PromptVersion | null) {
  if (row) selected.value = row
}

async function loadVersions() {
  loading.value = true
  loadFailed.value = false
  selected.value = null
  versions.value = []
  try {
    const { data } = await api.get<PromptVersion[]>(`/agents/${props.agentId}/prompt-versions`)
    versions.value = data
    selected.value = data[0] ?? null
  } catch {
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function rollback() {
  if (!selected.value || rollingBack.value) return
  const target = selected.value.version
  rollingBack.value = true
  try {
    await ElMessageBox.confirm(
      `确定将系统提示词回滚到 v${target} 吗？当前已保存的提示词将保留在历史中；其他配置不变。`,
      '确认回滚',
      { type: 'warning', confirmButtonText: '确认回滚', cancelButtonText: '取消' }
    )
    await api.post(`/agents/${props.agentId}/prompt-versions/${target}/rollback`)
    ElMessage.success('系统提示词已恢复')
    emit('restored')
    await loadVersions()
  } catch {
    // 取消不修改数据；请求错误由 API 拦截器提示。
  } finally {
    rollingBack.value = false
  }
}

onMounted(loadVersions)
</script>

<style scoped>
.history-content {
  margin-top: 16px;
}
</style>
