<template>
  <ResponsiveDialog
    :model-value="visible"
    :title="dialogTitle"
    width="760px"
    @update:model-value="$emit('update:visible', $event)"
    @close="$emit('update:visible', false)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="110px"
      label-position="right"
    >
      <el-tabs v-model="activeTab" class="agent-tabs">
      <el-tab-pane label="基本信息" name="basic">
      <el-form-item label="头像">
        <div class="avatar-editor">
          <el-avatar :size="72" :src="resolveAgentAvatarUrl(form.avatarUrl)" shape="square">{{ form.name.slice(0, 1) || 'A' }}</el-avatar>
          <div class="avatar-details">
            <div class="avatar-actions">
              <el-upload accept="image/png,image/jpeg,image/webp" :show-file-list="false" :http-request="uploadAvatar" :disabled="uploading || submitting" :before-upload="validateAvatar">
                <el-button type="primary" plain :loading="uploading" :disabled="submitting">{{ form.avatarUrl ? '更换头像' : '上传头像' }}</el-button>
              </el-upload>
              <el-button v-if="form.avatarUrl" link type="danger" :disabled="uploading || submitting" @click="form.avatarUrl = null">移除头像</el-button>
            </div>
            <p class="avatar-hint">PNG / JPEG / WebP · 最大 2 MB</p>
            <p class="avatar-hint">建议使用方形图片，不超过 4096 × 4096 像素，不支持动画。</p>
            <p class="avatar-note">保存后同步到客户端、后台和 SDK。</p>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="请输入 Agent 名称" />
      </el-form-item>
      <el-form-item label="描述" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="3" placeholder="请输入描述" />
      </el-form-item>
      <el-form-item label="Skills" prop="skillNames">
        <el-select
          v-model="form.skillNames"
          multiple
          filterable
          :loading="optionsLoading"
          placeholder="请选择关联的 Skill 知识文档（留空则加载全部）"
          style="width: 100%"
        >
          <el-option
            v-for="s in skillDocs"
            :key="s.name"
            :label="s.name"
            :value="s.name"
          />
        </el-select>
        <div v-if="optionsLoadFailed" class="options-error">
          <span>选项加载失败</span>
          <el-button type="primary" link size="small" :loading="optionsLoading" @click="loadOptions">重试</el-button>
        </div>
      </el-form-item>
      <el-form-item label="MCP 服务器">
        <el-select
          v-model="form.mcpServerIds"
          multiple
          filterable
          clearable
          :loading="optionsLoading"
          placeholder="请选择启用的 MCP 服务器（留空则不启用 MCP）"
          style="width: 100%"
        >
          <el-option
            v-for="s in mcpServers"
            :key="s.id"
            :label="`${s.name}（${s.serverType}）`"
            :value="s.id"
          />
        </el-select>
        <div class="form-hint">该 Agent 的会话可调用所选 MCP 服务器暴露的工具；建议关联不超过 10 台以避免工具清单膨胀。</div>
      </el-form-item>
      <el-form-item label="默认 Agent">
        <el-switch v-model="form.isDefault" />
        <span class="form-hint">开启后，新建会话未指定 Agent 时将使用该智能体</span>
      </el-form-item>
      <el-form-item label="默认模型">
        <el-select
          v-model="form.defaultModelId"
          filterable
          clearable
          :loading="optionsLoading"
          placeholder="跟随系统默认模型"
          style="width: 100%"
        >
          <el-option
            v-for="m in models"
            :key="m.id"
            :label="m.name"
            :value="m.id"
          />
        </el-select>
        <div class="form-hint">该 Agent 的会话未手动选择模型时优先使用；留空则跟随系统默认模型</div>
      </el-form-item>
      </el-tab-pane>
      <el-tab-pane label="角色提示词" name="prompt">
      <el-form-item label="角色定义" prop="systemPrompt">
        <el-input
          v-model="form.systemPrompt"
          type="textarea"
          :rows="15"
          placeholder="只需填写身份、业务目标与表达方式。页面规则、工具用法和安全边界由系统按会话通道注入。"
        />
        <div class="form-hint">嵌入网页浮窗、桌面编程、微信等通道规则由系统注入，此处只写本 Agent 的角色与风格。若已写过页面上下文或工具纪律，可删掉重复段。保存后自动记录提示词版本，可在 Agent 列表的「提示词版本」中预览和回滚。</div>
      </el-form-item>
      </el-tab-pane>
      <el-tab-pane label="最佳实践" name="experience">
      <div class="experience-panel">
        <div class="experience-toolbar">
          <el-segmented v-model="experienceView" :options="experienceViewOptions" @change="handleExperienceViewChange" />
          <span v-if="experienceView === 'text'" class="experience-hint">一行一条；# 开头表示停用</span>
        </div>
        <div v-show="experienceView === 'table'" class="experience-list">
          <el-table
            ref="experienceTableRef"
            :key="experienceTableKey"
            :data="form.experiences"
            row-key="_key"
            size="small"
            class="experience-table"
            :row-class-name="experienceRowClass"
          >
            <el-table-column width="40" align="center">
              <template #default>
                <span class="drag-handle" title="拖拽排序">⠿</span>
              </template>
            </el-table-column>
            <el-table-column label="#" width="48" align="center">
              <template #default="{ $index }">{{ $index + 1 }}</template>
            </el-table-column>
            <el-table-column label="正文">
              <template #default="{ row }">
                <el-input
                  :model-value="row.content"
                  :maxlength="300"
                  placeholder="请输入经验正文（最长 300 字）"
                  @update:model-value="(v: string) => (row.content = sanitizeExperienceContent(v))"
                />
              </template>
            </el-table-column>
            <el-table-column label="状态" width="64" align="center">
              <template #default="{ row }">
                <el-switch v-model="row.enabled" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="56" align="center">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeExperience($index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-button type="primary" link @click="addExperience">+ 添加经验</el-button>
        </div>
        <div v-show="experienceView === 'text'" class="experience-text-pane">
          <div class="experience-text-editor">
            <div class="experience-text-backdrop" aria-hidden="true">
              <div
                v-for="(line, index) in experienceBackdropLines"
                :key="index"
                class="experience-text-line"
                :class="[line.kind, { 'stripe': line.stripe }]"
              >&#8203;</div>
            </div>
            <el-input
              v-model="experienceText"
              type="textarea"
              class="experience-textarea"
              placeholder="一行一条经验；# 开头表示停用；空行忽略"
            />
          </div>
        </div>
      </div>
      </el-tab-pane>
      <el-tab-pane label="推荐问题" name="suggestedQuestions">
      <el-form-item label="推荐问题">
        <div class="experience-list">
          <div
            v-for="(item, index) in form.suggestedQuestions"
            :key="item._key"
            class="experience-item"
          >
            <el-input
              v-model="item.content"
              type="textarea"
              :rows="2"
              :maxlength="100"
              show-word-limit
              placeholder="请输入推荐问题（最长 100 字），用户点击后填入输入框"
            />
            <div class="experience-actions">
              <el-button link type="primary" :disabled="index === 0" @click="moveSuggestedQuestion(index, -1)">上移</el-button>
              <el-button link type="primary" :disabled="index === form.suggestedQuestions.length - 1" @click="moveSuggestedQuestion(index, 1)">下移</el-button>
              <el-button link type="danger" @click="removeSuggestedQuestion(index)">删除</el-button>
            </div>
          </div>
          <el-button type="primary" link @click="addSuggestedQuestion">+ 添加问题</el-button>
          <div class="form-hint">新会话空白态展示给用户的提问引导，最多 5 条。</div>
        </div>
      </el-form-item>
      </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="uploading" @click="handleSubmit">
        {{ submitButtonText }}
      </el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, reactive, nextTick, onBeforeUnmount } from 'vue'
import type { FormInstance, FormRules, UploadRawFile, UploadRequestOptions } from 'element-plus'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'
import { api } from '../../api'
import { resolveAgentAvatarUrl } from '../../utils/agent-avatar'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface ExperienceFormItem {
  _key: string
  id?: number | null
  content: string
  sortOrder: number
  enabled: boolean
}

interface SuggestedQuestionFormItem {
  _key: string
  id?: number | null
  content: string
  sortOrder: number
}

const props = withDefaults(defineProps<{
  visible: boolean
  agentData?: any | null
  mode?: 'create' | 'edit' | 'copy'
}>(), {
  agentData: null,
  mode: 'create'
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const isEdit = computed(() => props.mode === 'edit')
const dialogTitle = computed(() => {
  if (props.mode === 'edit') return '编辑 Agent'
  if (props.mode === 'copy') return '复制 Agent'
  return '创建 Agent'
})
const submitButtonText = computed(() => (isEdit.value ? '保存' : '创建'))
const submitting = ref(false)
const uploading = ref(false)
const activeTab = ref('basic')
const formRef = ref<FormInstance>()
const skillDocs = ref<any[]>([])
const mcpServers = ref<any[]>([])
const models = ref<any[]>([])
const optionsLoading = ref(false)
const optionsLoadFailed = ref(false)
const experienceView = ref<'table' | 'text'>('table')
const experienceText = ref('')
const experienceTableRef = ref()
const experienceTableKey = ref(0)
const experienceViewOptions = [
  { label: '表格', value: 'table' },
  { label: '文本', value: 'text' }
]
let experienceKeySeq = 0
let suggestedQuestionKeySeq = 0
let experienceSortable: Sortable | null = null
let experienceScrollTimer: ReturnType<typeof setInterval> | null = null

const experienceBackdropLines = computed(() =>
  experienceText.value.split(/\r?\n/).map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return { kind: 'empty', stripe: false }
    if (trimmed.startsWith('#')) return { kind: 'disabled', stripe: false }
    return { kind: 'active', stripe: index % 2 === 1 }
  })
)

function syncExperienceScroll() {
  const editorEl = document.querySelector('.experience-text-editor') as HTMLElement | null
  const textarea = editorEl?.querySelector('textarea')
  const backdrop = editorEl?.querySelector('.experience-text-backdrop') as HTMLElement | null
  if (!textarea || !backdrop) return
  backdrop.scrollTop = textarea.scrollTop
  backdrop.scrollLeft = textarea.scrollLeft
}

function startExperienceScrollSync() {
  stopExperienceScrollSync()
  // textarea 的 scroll 事件不总是冒泡，轮询兜底保证垫层跟随
  experienceScrollTimer = setInterval(syncExperienceScroll, 80)
}

function stopExperienceScrollSync() {
  if (experienceScrollTimer) {
    clearInterval(experienceScrollTimer)
    experienceScrollTimer = null
  }
}

const form = reactive({
  avatarUrl: null as string | null,
  name: '',
  description: '',
  systemPrompt: '',
  skillNames: [] as string[],
  mcpServerIds: [] as number[],
  experiences: [] as ExperienceFormItem[],
  suggestedQuestions: [] as SuggestedQuestionFormItem[],
  isDefault: false,
  defaultModelId: null as number | null
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入 Agent 名称', trigger: 'blur' }],
  systemPrompt: [{ required: true, message: '请输入角色定义', trigger: 'blur' }]
}

function nextExperienceKey() {
  experienceKeySeq += 1
  return `exp-${experienceKeySeq}`
}

function mapExperiences(source: any[] | undefined | null, keepId: boolean): ExperienceFormItem[] {
  if (!source || source.length === 0) return []
  return source.map((item, index) => ({
    _key: nextExperienceKey(),
    id: keepId ? item.id ?? null : null,
    content: item.content || '',
    sortOrder: item.sortOrder ?? index,
    enabled: item.enabled !== false
  }))
}

function nextSuggestedQuestionKey() {
  suggestedQuestionKeySeq += 1
  return `sq-${suggestedQuestionKeySeq}`
}

function mapSuggestedQuestions(source: any[] | undefined | null, keepId: boolean): SuggestedQuestionFormItem[] {
  if (!source || source.length === 0) return []
  return source.map((item, index) => ({
    _key: nextSuggestedQuestionKey(),
    id: keepId ? item.id ?? null : null,
    content: item.content || '',
    sortOrder: item.sortOrder ?? index
  }))
}

function resetForm() {
  Object.assign(form, {
    avatarUrl: null,
    name: '',
    description: '',
    systemPrompt: '',
    skillNames: [],
    mcpServerIds: [],
    experiences: [],
    suggestedQuestions: [],
    isDefault: false,
    defaultModelId: null
  })
}

function addExperience() {
  form.experiences.push({
    _key: nextExperienceKey(),
    id: null,
    content: '',
    sortOrder: form.experiences.length,
    enabled: true
  })
}

function removeExperience(index: number) {
  form.experiences.splice(index, 1)
  form.experiences.forEach((item, i) => {
    item.sortOrder = i
  })
}

function sanitizeExperienceContent(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ')
}

function experienceRowClass({ row }: { row: ExperienceFormItem }) {
  return row.enabled ? '' : 'experience-row-disabled'
}

function experiencesToText(list: ExperienceFormItem[]): string {
  return list
    .map(item => (item.enabled ? item.content : `# ${item.content}`))
    .join('\n')
}

type TextParseResult =
  | { ok: true; items: ExperienceFormItem[] }
  | { ok: false; error: string }

function textToExperiences(text: string, previous: ExperienceFormItem[]): TextParseResult {
  const lines = text.split(/\r?\n/)
  const parsed: { content: string; enabled: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const lineNo = i + 1
    let enabled = true
    let content = line.trim()
    if (content.startsWith('#')) {
      enabled = false
      content = content.replace(/^#\s?/, '').trim()
    }
    if (!content) {
      return { ok: false, error: `第 ${lineNo} 行：内容为空` }
    }
    if (content.length > 300) {
      return { ok: false, error: `第 ${lineNo} 行：超过 300 字（当前 ${content.length} 字）` }
    }
    if (content.startsWith('#')) {
      return { ok: false, error: `第 ${lineNo} 行：正文不能以 # 开头` }
    }
    parsed.push({ content, enabled })
  }
  const items = parsed.map((entry, index) => ({
    _key: nextExperienceKey(),
    id: index < previous.length ? previous[index].id ?? null : null,
    content: entry.content,
    sortOrder: index,
    enabled: entry.enabled
  }))
  return { ok: true, items }
}

function handleExperienceViewChange(value: string | number | boolean) {
  if (value === 'text') {
    experienceText.value = experiencesToText(form.experiences)
    return
  }
  if (value === 'table') {
    const result = textToExperiences(experienceText.value, form.experiences)
    if (!result.ok) {
      ElMessage.warning(result.error)
      experienceView.value = 'text'
      return
    }
    form.experiences = result.items
  }
}

function syncExperiencesFromTextView(): boolean {
  const result = textToExperiences(experienceText.value, form.experiences)
  if (!result.ok) {
    ElMessage.warning(result.error)
    return false
  }
  form.experiences = result.items
  return true
}

async function mountExperienceSortable() {
  destroyExperienceSortable()
  if (experienceView.value !== 'table' || !props.visible) return
  await nextTick()
  const tableEl = experienceTableRef.value?.$el as HTMLElement | undefined
  const tbody = tableEl?.querySelector('.el-table__body-wrapper tbody') as HTMLTableSectionElement | null
  if (!tbody) return
  experienceSortable = Sortable.create(tbody, {
    handle: '.drag-handle',
    animation: 150,
    onEnd: ({ oldIndex, newIndex }) => {
      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
      const list = [...form.experiences]
      const [moved] = list.splice(oldIndex, 1)
      list.splice(newIndex, 0, moved)
      list.forEach((item, i) => {
        item.sortOrder = i
      })
      form.experiences = list
      // Sortable 已直接改过 DOM，重建表格使虚拟 DOM 与真实顺序对齐
      experienceTableKey.value += 1
      mountExperienceSortable()
    }
  })
}

function destroyExperienceSortable() {
  experienceSortable?.destroy()
  experienceSortable = null
}

function addSuggestedQuestion() {
  if (form.suggestedQuestions.length >= 5) {
    ElMessage.warning('推荐问题最多 5 条')
    return
  }
  form.suggestedQuestions.push({
    _key: nextSuggestedQuestionKey(),
    id: null,
    content: '',
    sortOrder: form.suggestedQuestions.length
  })
}

function removeSuggestedQuestion(index: number) {
  form.suggestedQuestions.splice(index, 1)
  form.suggestedQuestions.forEach((item, i) => {
    item.sortOrder = i
  })
}

function moveSuggestedQuestion(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= form.suggestedQuestions.length) return
  const list = form.suggestedQuestions
  const tmp = list[index]
  list[index] = list[target]
  list[target] = tmp
  list.forEach((item, i) => {
    item.sortOrder = i
  })
}

function validateExperiences(): boolean {
  for (let i = 0; i < form.experiences.length; i++) {
    const content = (form.experiences[i].content || '').trim()
    if (!content) {
      ElMessage.warning(`第 ${i + 1} 条经验不能为空`)
      return false
    }
    if (content.length > 300) {
      ElMessage.warning(`第 ${i + 1} 条经验不能超过 300 字`)
      return false
    }
    if (content.startsWith('#')) {
      ElMessage.warning(`第 ${i + 1} 条经验正文不能以 # 开头`)
      return false
    }
  }
  return true
}

function validateSuggestedQuestions(): boolean {
  if (form.suggestedQuestions.length > 5) {
    ElMessage.warning('推荐问题最多 5 条')
    return false
  }
  for (let i = 0; i < form.suggestedQuestions.length; i++) {
    const content = (form.suggestedQuestions[i].content || '').trim()
    if (!content) {
      ElMessage.warning(`第 ${i + 1} 条推荐问题不能为空`)
      return false
    }
    if (content.length > 100) {
      ElMessage.warning(`第 ${i + 1} 条推荐问题不能超过 100 字`)
      return false
    }
  }
  return true
}

watch(() => props.visible, async (val) => {
  if (!val) {
    destroyExperienceSortable()
    stopExperienceScrollSync()
    return
  }
  activeTab.value = 'basic'
  experienceView.value = 'table'
  experienceText.value = ''
  if (props.agentData) {
    Object.assign(form, {
      avatarUrl: props.agentData.avatarUrl || null,
      name: props.mode === 'copy' ? `${props.agentData.name || ''} - 副本` : props.agentData.name || '',
      description: props.agentData.description || '',
      systemPrompt: props.agentData.systemPrompt || '',
      skillNames: props.agentData.skillNames || [],
      mcpServerIds: props.agentData.mcpServerIds || [],
      experiences: mapExperiences(props.agentData.experiences, props.mode === 'edit'),
      suggestedQuestions: mapSuggestedQuestions(props.agentData.suggestedQuestions, props.mode === 'edit'),
      isDefault: props.mode === 'copy' ? false : !!props.agentData.isDefault,
      defaultModelId: props.mode === 'copy' ? null : props.agentData.defaultModelId ?? null
    })
  } else {
    resetForm()
  }

  formRef.value?.clearValidate()
  await loadOptions()
  await mountExperienceSortable()
}, { immediate: true })

watch([experienceView, activeTab], () => {
  if (experienceView.value === 'table' && activeTab.value === 'experience') {
    mountExperienceSortable()
  }
  if (experienceView.value === 'text' && activeTab.value === 'experience' && props.visible) {
    nextTick(startExperienceScrollSync)
  } else {
    stopExperienceScrollSync()
  }
})

onBeforeUnmount(() => {
  destroyExperienceSortable()
  stopExperienceScrollSync()
})

async function loadOptions() {
  optionsLoading.value = true
  optionsLoadFailed.value = false
  const failed: string[] = []
  try {
    const { data } = await api.get('/skill-docs')
    skillDocs.value = data || []
  } catch {
    skillDocs.value = []
    failed.push('Skills')
  }
  try {
    const { data: mcpData } = await api.get('/mcp-servers/enabled')
    mcpServers.value = mcpData || []
  } catch {
    mcpServers.value = []
    failed.push('MCP')
  }
  try {
    const { data: modelData } = await api.get('/models/active')
    models.value = modelData || []
  } catch {
    models.value = []
    failed.push('模型')
  }
  optionsLoading.value = false
  if (failed.length > 0) {
    optionsLoadFailed.value = true
    ElMessage.warning(`${failed.join('、')}选项加载失败，请重试`)
  }
}

function validateAvatar(file: UploadRawFile) {
  // WeChat's in-app image editor returns files with an empty or generic MIME type;
  // fall back to the filename extension when file.type is not a usable image type.
  const mimeOk = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
  const extOk = /\.(png|jpe?g|webp)$/i.test(file.name)
  if (!(mimeOk || (['', 'application/octet-stream'].includes(file.type) && extOk))) {
    ElMessage.warning('请选择 PNG、JPEG 或 WebP 图片')
    return false
  }
  if (file.size > 2 * 1024 * 1024) {
    ElMessage.warning('头像大小不能超过 2 MB')
    return false
  }
  return true
}

async function uploadAvatar(options: UploadRequestOptions) {
  uploading.value = true
  try {
    const body = new FormData()
    body.append('file', options.file)
    const { data } = await api.post('/agents/avatar', body, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    form.avatarUrl = data.avatarUrl
  } catch {
    ElMessage.error('头像上传失败，请重试')
  } finally {
    uploading.value = false
  }
}

async function handleSubmit() {
  if (uploading.value || submitting.value) return
  const valid = await formRef.value?.validate().catch((fields) => {
    activeTab.value = fields?.name ? 'basic' : 'prompt'
    return false
  })
  if (!valid) return
  if (experienceView.value === 'text') {
    activeTab.value = 'experience'
    if (!syncExperiencesFromTextView()) return
  }
  if (!validateExperiences()) {
    activeTab.value = 'experience'
    return
  }
  if (!validateSuggestedQuestions()) {
    activeTab.value = 'suggestedQuestions'
    return
  }

  const payload = {
    avatarUrl: form.avatarUrl,
    name: form.name,
    description: form.description,
    systemPrompt: form.systemPrompt,
    skillNames: form.skillNames,
    mcpServerIds: form.mcpServerIds,
    isDefault: form.isDefault ? 1 : 0,
    defaultModelId: form.defaultModelId || null,
    experiences: form.experiences.map((item, index) => ({
      id: isEdit.value ? item.id ?? null : null,
      content: item.content.trim(),
      sortOrder: index,
      enabled: item.enabled
    })),
    suggestedQuestions: form.suggestedQuestions.map((item, index) => ({
      id: isEdit.value ? item.id ?? null : null,
      content: item.content.trim(),
      sortOrder: index
    }))
  }

  submitting.value = true
  try {
    if (isEdit.value && props.agentData?.id) {
      await api.put(`/agents/${props.agentData.id}`, payload)
      ElMessage.success('Agent 更新成功')
    } else {
      await api.post('/agents', payload)
      ElMessage.success(props.mode === 'copy' ? 'Agent 复制成功' : 'Agent 创建成功')
    }
    emit('update:visible', false)
    emit('saved')
  } catch {
    // Error handled by interceptor
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.agent-tabs :deep(.el-tab-pane) {
  height: min(440px, 55vh);
  overflow-y: auto;
  padding: 12px 12px 0 0;
}
.avatar-editor {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 14px;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.avatar-editor .el-avatar { flex-shrink: 0; }
.avatar-details { min-width: 0; }
.avatar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-bottom: 8px; }
.avatar-actions .el-button { margin-left: 0; }
.avatar-hint, .avatar-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
.avatar-note { margin-top: 4px; }
@media (max-width: 767px) {
  .agent-tabs :deep(.el-tab-pane) { height: calc(100dvh - 240px); }
  .avatar-editor { align-items: flex-start; flex-direction: column; gap: 12px; }
}
.experience-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.experience-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.experience-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.experience-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1;
}

/* 推荐问题 Tab 仍用卡片列表 */
.experience-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}

.experience-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.experience-table {
  width: 100%;
}

.experience-table :deep(.experience-row-disabled .cell),
.experience-table :deep(.experience-row-disabled .el-input__wrapper) {
  opacity: 0.65;
}

.drag-handle {
  cursor: grab;
  color: var(--el-text-color-secondary);
  user-select: none;
}

.drag-handle:active {
  cursor: grabbing;
}

.experience-text-pane {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 底层斑马纹垫层 + 透明 textarea 叠加，实现逐行跳色 */
.experience-text-editor {
  position: relative;
  flex: 1;
  min-height: 280px;
}

.experience-text-backdrop {
  position: absolute;
  inset: 5px 11px 5px 11px;
  overflow: hidden;
  border-radius: 4px;
  pointer-events: none;
  /* 与 textarea 底色一致；启用行/停用行/空行在此之上呈现三态 */
  background: var(--el-fill-color-blank);
}

.experience-text-line {
  height: 24px;
  line-height: 24px;
  font-size: 13px;
}

/* 斑马纹：启用行按行号奇偶交替，停用行警示黄，空行不着色 */
.experience-text-line.active {
  background: var(--el-fill-color-blank);
}

.experience-text-line.active.stripe {
  background: var(--el-fill-color-light);
}

.experience-text-line.disabled {
  background: var(--el-color-warning-light-8);
}

.experience-textarea {
  position: relative;
  z-index: 1;
  height: 100%;
  min-height: 280px;
}

.experience-textarea :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 280px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 24px;
  background: transparent;
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;
  resize: none;
}

.experience-textarea :deep(.el-textarea__inner)::placeholder {
  background: var(--el-bg-color);
  color: var(--el-text-color-placeholder);
}

.form-hint {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.options-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.agent-tabs :deep(.el-tab-pane:has(.experience-panel)) {
  height: min(560px, 65vh);
}

@media (max-width: 767px) {
  .agent-tabs :deep(.el-tab-pane:has(.experience-panel)) {
    height: calc(100dvh - 240px);
  }
  .experience-text-editor,
  .experience-textarea,
  .experience-textarea :deep(.el-textarea__inner) {
    min-height: 200px;
  }
}
</style>
