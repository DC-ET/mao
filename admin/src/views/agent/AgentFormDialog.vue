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
      </el-form-item>
      <el-form-item label="MCP 服务器">
        <el-select
          v-model="form.mcpServerIds"
          multiple
          filterable
          clearable
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
      <el-form-item label="最佳实践经验">
        <div class="experience-list">
          <div
            v-for="(item, index) in form.experiences"
            :key="item._key"
            class="experience-item"
          >
            <el-input
              v-model="item.content"
              type="textarea"
              :rows="2"
              :maxlength="300"
              show-word-limit
              placeholder="请输入经验正文（最长 300 字）"
            />
            <div class="experience-actions">
              <el-switch v-model="item.enabled" active-text="启用" inactive-text="停用" />
              <el-button link type="primary" :disabled="index === 0" @click="moveExperience(index, -1)">上移</el-button>
              <el-button link type="primary" :disabled="index === form.experiences.length - 1" @click="moveExperience(index, 1)">下移</el-button>
              <el-button link type="danger" @click="removeExperience(index)">删除</el-button>
            </div>
          </div>
          <el-button type="primary" link @click="addExperience">+ 添加经验</el-button>
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
import { computed, ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules, UploadRawFile, UploadRequestOptions } from 'element-plus'
import { ElMessage } from 'element-plus'
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
let experienceKeySeq = 0

const form = reactive({
  avatarUrl: null as string | null,
  name: '',
  description: '',
  systemPrompt: '',
  skillNames: [] as string[],
  mcpServerIds: [] as number[],
  experiences: [] as ExperienceFormItem[],
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

function resetForm() {
  Object.assign(form, {
    avatarUrl: null,
    name: '',
    description: '',
    systemPrompt: '',
    skillNames: [],
    mcpServerIds: [],
    experiences: [],
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

function moveExperience(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= form.experiences.length) return
  const list = form.experiences
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
  }
  return true
}

watch(() => props.visible, async (val) => {
  if (!val) return
  activeTab.value = 'basic'
  if (props.agentData) {
    Object.assign(form, {
      avatarUrl: props.agentData.avatarUrl || null,
      name: props.mode === 'copy' ? `${props.agentData.name || ''} - 副本` : props.agentData.name || '',
      description: props.agentData.description || '',
      systemPrompt: props.agentData.systemPrompt || '',
      skillNames: props.agentData.skillNames || [],
      mcpServerIds: props.agentData.mcpServerIds || [],
      experiences: mapExperiences(props.agentData.experiences, props.mode === 'edit'),
      isDefault: props.mode === 'copy' ? false : !!props.agentData.isDefault,
      defaultModelId: props.mode === 'copy' ? null : props.agentData.defaultModelId ?? null
    })
  } else {
    resetForm()
  }

  formRef.value?.clearValidate()
  await loadOptions()
}, { immediate: true })

async function loadOptions() {
  try {
    const { data } = await api.get('/skill-docs')
    skillDocs.value = data || []
  } catch { /* 拦截器已提示失败，技能下拉留空 */ }
  try {
    const { data: mcpData } = await api.get('/mcp-servers/enabled')
    mcpServers.value = mcpData || []
  } catch {
    mcpServers.value = []
  }
  try {
    const { data: modelData } = await api.get('/models/active')
    models.value = modelData || []
  } catch {
    models.value = []
  }
}

function validateAvatar(file: UploadRawFile) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
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
  if (!validateExperiences()) {
    activeTab.value = 'experience'
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
.experience-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

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

.form-hint {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
