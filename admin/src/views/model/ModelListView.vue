<template>
  <div class="model-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>模型配置</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            添加模型
          </el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab" class="model-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="文本模型" name="text" />
        <el-tab-pane label="语音模型" name="audio" />
        <el-tab-pane label="文生图" name="image" />
      </el-tabs>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="state.filters.keyword"
                clearable
                placeholder="名称 / 模型标识 / 供应商"
                style="width: 220px"
                @keyup.enter="handleSearch"
                @clear="handleSearch"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="供应商">
            <el-select v-model="state.filters.provider" clearable filterable placeholder="全部供应商" style="width: 150px" @change="handleSearch">
              <el-option v-for="provider in providerOptions" :key="provider" :label="provider" :value="provider" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="state.filters.status" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
              <el-option label="启用" :value="1" />
              <el-option label="禁用" :value="0" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="isTextTab" label="视觉">
            <el-select v-model="state.filters.supportsVision" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
              <el-option label="支持" :value="1" />
              <el-option label="不支持" :value="0" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="isTextTab" label="默认">
            <el-select v-model="state.filters.isDefault" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
              <el-option label="默认" :value="1" />
              <el-option label="非默认" :value="0" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="state.models" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="provider" label="供应商" width="120" />
        <el-table-column prop="modelId" label="模型标识" width="150" />
        <el-table-column prop="baseUrl" label="API 地址" min-width="200" show-overflow-tooltip />
        <el-table-column v-if="isTextTab" label="上下文窗口" width="120" align="right">
          <template #default="{ row }">
            {{ row.contextWindowTokens ? row.contextWindowTokens.toLocaleString() : '-' }}
          </template>
        </el-table-column>
        <el-table-column v-if="isTextTab" label="视觉" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.supportsVision ? 'success' : 'info'" size="small">
              {{ row.supportsVision ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="isTextTab" label="默认" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              size="small"
              :loading="testingId === row.id"
              :disabled="testingId === row.id"
              @click="handleTest(row)"
            >测试</el-button>
            <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button
              :type="row.status === 1 ? 'danger' : 'success'"
              link
              size="small"
              @click="handleToggleStatus(row)"
            >
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in state.models" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
              {{ row.status === 1 ? '启用' : '禁用' }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">供应商</span>
            <span>{{ row.provider }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">标识</span>
            <span>{{ row.modelId }}</span>
          </div>
          <div v-if="isTextTab" class="mobile-card-row">
            <span class="mobile-card-label">视觉</span>
            <span>{{ row.supportsVision ? '支持' : '不支持' }}</span>
          </div>
          <div class="mobile-card-actions">
            <el-button type="primary" link :loading="testingId === row.id" @click="handleTest(row)">测试</el-button>
            <el-button type="primary" link @click="handleCopy(row)">复制</el-button>
            <el-button type="primary" link @click="handleEdit(row)">编辑</el-button>
            <el-button :type="row.status === 1 ? 'danger' : 'success'" link @click="handleToggleStatus(row)">
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
            <el-button type="danger" link @click="handleDelete(row)">删除</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && state.models.length === 0" description="暂无数据" />
      </div>

      <div class="pagination">
        <ResponsivePagination
          v-model:current-page="state.currentPage"
          v-model:page-size="state.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="state.total"
          @current-change="fetchModels"
          @size-change="handleSizeChange"
        />
      </div>
    </el-card>

    <ModelFormDialog
      v-if="dialogVisible"
      :visible="true"
      :model-data="currentModel"
      :mode="dialogMode"
      :default-type="activeTab"
      @update:visible="dialogVisible = $event"
      @saved="fetchModels"
    />

    <el-dialog
      v-model="testResultVisible"
      title="模型测试结果"
      width="640px"
      destroy-on-close
    >
      <div v-if="testResult" class="test-result-dialog">
        <div class="test-result-summary" :class="`is-${testResultType}`">
          <el-tag :type="testResultTagType" size="large">{{ testResultTitle }}</el-tag>
          <span class="test-result-duration">耗时 {{ testResult.durationMs }}ms</span>
        </div>

        <!-- 语音模型：音频试听与合成信息 -->
        <template v-if="testResult.audioTest">
          <div class="test-result-section">
            <div class="test-result-section__header">
              <span class="test-result-section__title">合成音频</span>
              <el-tag :type="testResult.connectivity ? 'success' : 'danger'" size="small">
                {{ testResult.connectivity ? '合成成功' : '合成失败' }}
              </el-tag>
            </div>
            <div v-if="testResult.connectivity && testResult.audioData" class="test-result-audio">
              <audio :src="audioSrc" controls class="test-result-audio__player" />
              <div class="test-result-audio__meta">
                <span v-if="testResult.audioFormat">格式：{{ testResult.audioFormat }}</span>
                <span v-if="testResult.audioSizeBytes">大小：{{ formatBytes(testResult.audioSizeBytes) }}</span>
                <span v-if="testResult.audioSampleRate">采样率：{{ testResult.audioSampleRate }} Hz</span>
                <span v-if="testResult.audioDurationMs">时长：{{ formatDuration(testResult.audioDurationMs) }}</span>
              </div>
            </div>
            <div v-else class="test-result-label">未生成音频数据</div>
          </div>
        </template>

        <!-- 文本模型：连通性输出 -->
        <template v-else>
          <div class="test-result-section">
            <div class="test-result-section__header">
              <span class="test-result-section__title">连通性</span>
              <el-tag :type="testResult.connectivity ? 'success' : 'danger'" size="small">
                {{ testResult.connectivity ? '通过' : '失败' }}
              </el-tag>
            </div>
            <div class="test-result-label">模型输出</div>
            <pre class="test-result-output">{{ formatTestOutput(testResult.connectivityOutput) }}</pre>
          </div>

          <div class="test-result-section">
            <div class="test-result-section__header">
              <span class="test-result-section__title">Mid System Message</span>
              <el-tag :type="testResult.midSystemMessage ? 'success' : 'warning'" size="small">
                {{ testResult.midSystemMessage ? '支持' : '不支持' }}
              </el-tag>
            </div>
            <div class="test-result-label">模型输出</div>
            <pre class="test-result-output">{{ formatTestOutput(testResult.midSystemMessageOutput) }}</pre>
            <div class="test-result-hint">期望输出：MAO_BRAVO（而非 MAO_ALPHA）</div>
          </div>
        </template>

        <el-alert
          v-if="testResult.error"
          class="test-result-error"
          type="error"
          :closable="false"
          show-icon
          :title="testResult.error"
        />
      </div>

      <template #footer>
        <el-button type="primary" @click="testResultVisible = false">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import ModelFormDialog from './ModelFormDialog.vue'

const { isMobile } = useBreakpoint()

type TabType = 'text' | 'audio' | 'image'

interface TabState {
  models: any[]
  total: number
  currentPage: number
  pageSize: number
  filters: {
    keyword: string
    provider: string
    status?: number
    supportsVision?: number
    isDefault?: number
  }
}

function createTabState(): TabState {
  return reactive<TabState>({
    models: [],
    total: 0,
    currentPage: 1,
    pageSize: 10,
    filters: {
      keyword: '',
      provider: '',
      status: undefined,
      supportsVision: undefined,
      isDefault: undefined
    }
  })
}

const activeTab = ref<TabType>('text')
const tabStates: Record<TabType, TabState> = {
  text: createTabState(),
  audio: createTabState(),
  image: createTabState()
}
const state = computed(() => tabStates[activeTab.value])
const isTextTab = computed(() => activeTab.value === 'text')

const loading = ref(false)
const providerOptions = ref<string[]>([])
const dialogVisible = ref(false)
const currentModel = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')
const testingId = ref<number | null>(null)
const testResultVisible = ref(false)
const testResult = ref<any>(null)

async function fetchModels() {
  loading.value = true
  try {
    const tab = activeTab.value
    const params: Record<string, string | number> = {
      page: tabStates[tab].currentPage,
      size: tabStates[tab].pageSize,
      modelType: tab
    }
    const filters = tabStates[tab].filters
    if (filters.keyword) params.keyword = filters.keyword
    if (filters.provider) params.provider = filters.provider
    if (filters.status !== undefined) params.status = filters.status
    if (filters.supportsVision !== undefined) params.supportsVision = filters.supportsVision
    if (filters.isDefault !== undefined) params.isDefault = filters.isDefault

    const { data } = await api.get('/models', { params })
    tabStates[tab].models = data?.records || []
    tabStates[tab].total = data?.total || 0
  } finally {
    loading.value = false
  }
}

async function fetchProviderOptions() {
  const { data } = await api.get('/models/providers')
  providerOptions.value = data || []
}

function handleCreate() {
  dialogMode.value = 'create'
  currentModel.value = null
  dialogVisible.value = true
}

async function loadModelDetail(id: number) {
  const { data } = await api.get(`/models/${id}`)
  return data
}

async function handleCopy(row: any) {
  const detail = await loadModelDetail(row.id)
  dialogMode.value = 'copy'
  currentModel.value = detail
  dialogVisible.value = true
}

async function handleEdit(row: any) {
  const detail = await loadModelDetail(row.id)
  dialogMode.value = 'edit'
  currentModel.value = detail
  dialogVisible.value = true
}

function handleSizeChange() {
  state.value.currentPage = 1
  fetchModels()
}

function handleSearch() {
  state.value.currentPage = 1
  fetchModels()
}

function handleReset() {
  Object.assign(state.value.filters, {
    keyword: '',
    provider: '',
    status: undefined,
    supportsVision: undefined,
    isDefault: undefined
  })
  handleSearch()
}

function handleTabChange() {
  // 切换 tab 时按需加载该 tab 数据（首次进入时加载）
  const tab = activeTab.value
  if (tabStates[tab].models.length === 0) {
    fetchModels()
  }
}

function formatTestOutput(output?: string | null) {
  return output?.trim() ? output : '(空响应)'
}

const audioSrc = computed(() => {
  if (!testResult.value?.audioTest || !testResult.value.audioData) return ''
  const format = testResult.value.audioFormat || 'wav'
  return `data:audio/${format};base64,${testResult.value.audioData}`
})

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatDuration(ms: number) {
  if (!ms || ms <= 0) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

const testResultType = computed(() => {
  if (!testResult.value) return 'error'
  if (testResult.value.audioTest) {
    return testResult.value.connectivity ? 'success' : 'error'
  }
  if (testResult.value.connectivity && testResult.value.midSystemMessage) return 'success'
  if (testResult.value.connectivity) return 'warning'
  return 'error'
})

const testResultTitle = computed(() => {
  if (testResultType.value === 'success') {
    return testResult.value?.audioTest ? '合成成功' : '测试通过'
  }
  if (testResultType.value === 'warning') return '部分通过'
  return testResult.value?.audioTest ? '合成失败' : '测试失败'
})

const testResultTagType = computed(() => {
  if (testResultType.value === 'success') return 'success'
  if (testResultType.value === 'warning') return 'warning'
  return 'danger'
})

async function handleTest(row: any) {
  if (testingId.value != null) return
  testingId.value = row.id
  try {
    const { data } = await api.post(`/models/${row.id}/test`)
    testResult.value = data
    testResultVisible.value = true
  } catch {
    // Error handled by interceptor
  } finally {
    testingId.value = null
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除模型 "${row.name}" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/models/${row.id}`)
    ElMessage.success('删除成功')
    // Step back a page if we just emptied the current page, so we never land on a blank page.
    const remainingOnPage = state.value.models.length - 1
    const maxPage = Math.max(1, Math.ceil((state.value.total - 1) / state.value.pageSize))
    if (remainingOnPage === 0 && state.value.currentPage > maxPage) {
      state.value.currentPage = maxPage
    }
    fetchModels()
  } catch {
    // Cancelled
  }
}

async function handleToggleStatus(row: any) {
  const enable = row.status !== 1
  const actionText = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确定要${actionText}模型 "${row.name}" 吗？`, '确认', {
      type: enable ? 'success' : 'warning'
    })
    await api.patch(`/models/${row.id}/status`, { status: enable ? 1 : 0 })
    ElMessage.success(`${actionText}成功`)
    fetchModels()
  } catch {
    // Cancelled or error handled by interceptor
  }
}

onMounted(() => {
  fetchProviderOptions()
  fetchModels()
})
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.model-tabs {
  margin-bottom: 4px;
}

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}

.search-form {
  margin-bottom: 16px;
}

.test-result-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.test-result-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.test-result-summary.is-success {
  background: var(--el-color-success-light-9);
}

.test-result-summary.is-warning {
  background: var(--el-color-warning-light-9);
}

.test-result-summary.is-error {
  background: var(--el-color-danger-light-9);
}

.test-result-duration {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.test-result-section {
  padding: 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.test-result-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.test-result-section__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.test-result-label {
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.test-result-output {
  margin: 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
}

.test-result-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.test-result-audio {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.test-result-audio__player {
  width: 100%;
  height: 40px;
}

.test-result-audio__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.test-result-error {
  margin-top: 4px;
}
</style>
