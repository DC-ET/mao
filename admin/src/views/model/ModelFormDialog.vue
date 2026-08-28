<template>
  <ResponsiveDialog
    :model-value="visible"
    :title="dialogTitle"
    width="580px"
    @update:model-value="$emit('update:visible', $event)"
    @close="$emit('update:visible', false)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <el-form-item label="模型类型" prop="modelType">
        <el-radio-group v-model="form.modelType">
          <el-radio value="text">文本模型</el-radio>
          <el-radio value="audio">语音模型</el-radio>
          <el-radio value="image">文生图</el-radio>
        </el-radio-group>
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">语音模型用于 TTS 等音频合成，文生图用于图片生成</span>
      </el-form-item>
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="例如: GPT-4o, Claude Opus" />
      </el-form-item>
      <el-form-item label="供应商" prop="provider">
        <el-input v-model="form.provider" placeholder="例如: OpenAI, Anthropic" />
      </el-form-item>
      <el-form-item label="API 协议">
        <el-select v-model="form.apiProtocol" style="width: 100%">
          <el-option label="OpenAI 兼容（ChatCompletions）" value="" />
          <el-option label="Anthropic（Messages）" value="anthropic" />
          <el-option label="OpenAI Responses（规划中）" value="openai-responses" disabled />
        </el-select>
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">决定调用该模型使用的 API 协议，供应商仅作渠道标识</span>
      </el-form-item>
      <el-form-item label="模型标识" prop="modelId">
        <el-input v-model="form.modelId" placeholder="例如: gpt-4o, mimo-v2.5-tts" />
      </el-form-item>
      <el-form-item label="客户端标识">
        <el-radio-group v-model="form.clientImpersonation">
          <el-radio value="none">None</el-radio>
          <el-radio value="codex">Codex</el-radio>
          <el-radio value="claude_code">Claude Code</el-radio>
        </el-radio-group>
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">调用该模型时模拟的客户端请求头</span>
      </el-form-item>
      <el-form-item label="API 地址" prop="baseUrl">
        <el-input v-model="form.baseUrl" placeholder="例如: https://api.openai.com/v1" />
      </el-form-item>
      <el-form-item label="API Key" prop="apiKey">
        <el-input v-model="form.apiKey" type="password" show-password :placeholder="isEdit ? '留空则不修改' : '请输入 API Key'" />
      </el-form-item>
      <el-form-item v-if="isTextType" label="上下文窗口">
        <el-input-number
          v-model="form.contextWindowTokens"
          :min="1024"
          :max="2000000"
          :step="1024"
          style="width: 220px"
        />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">用于上下文压缩水位展示</span>
      </el-form-item>
      <el-form-item v-if="isTextType" label="支持视觉">
        <el-switch v-model="form.supportsVision" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">开启后可在任务中发送图片</span>
      </el-form-item>
      <el-form-item v-if="isTextType" label="默认模型">
        <el-switch v-model="form.isDefault" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">新会话默认使用此模型</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ submitButtonText }}
      </el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

const props = withDefaults(defineProps<{
  visible: boolean
  modelData?: any | null
  mode?: 'create' | 'edit' | 'copy'
  defaultType?: 'text' | 'audio' | 'image'
}>(), {
  modelData: null,
  mode: 'create',
  defaultType: 'text'
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const isEdit = computed(() => props.mode === 'edit')
const dialogTitle = computed(() => {
  if (props.mode === 'edit') return '编辑模型'
  if (props.mode === 'copy') return '复制模型'
  return '添加模型'
})
const submitButtonText = computed(() => (isEdit.value ? '保存' : '添加'))
const isTextType = computed(() => form.modelType === 'text')
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  modelType: 'text',
  name: '',
  provider: '',
  apiProtocol: '',
  modelId: '',
  clientImpersonation: 'none',
  baseUrl: '',
  apiKey: '',
  contextWindowTokens: 256000,
  supportsVision: false,
  isDefault: false
})

const rules = computed<FormRules>(() => ({
  name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
  modelId: [{ required: true, message: '请输入模型标识', trigger: 'blur' }],
  apiKey: isEdit.value
    ? []
    : [{ required: true, message: '请输入 API Key', trigger: 'blur' }]
}))

function resetForm() {
  Object.assign(form, {
    modelType: props.defaultType,
    name: '',
    provider: '',
    apiProtocol: '',
    modelId: '',
    clientImpersonation: 'none',
    baseUrl: '',
    apiKey: '',
    contextWindowTokens: 256000,
    supportsVision: false,
    isDefault: false
  })
}

watch(() => props.visible, (val) => {
  if (!val) return
  if (props.modelData) {
    Object.assign(form, {
      modelType: props.modelData.modelType || 'text',
      name: props.mode === 'copy' ? `${props.modelData.name || ''} - 副本` : props.modelData.name || '',
      provider: props.modelData.provider || '',
      apiProtocol: props.modelData.apiProtocol || '',
      modelId: props.modelData.modelId || '',
      clientImpersonation: props.modelData.clientImpersonation || 'none',
      baseUrl: props.modelData.baseUrl || '',
      apiKey: props.modelData.apiKey || '',
      contextWindowTokens: props.modelData.contextWindowTokens || 256000,
      supportsVision: !!props.modelData.supportsVision,
      isDefault: !!props.modelData.isDefault
    })
  } else {
    resetForm()
  }

  formRef.value?.clearValidate()
}, { immediate: true })

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const payload: any = { ...form, supportsVision: form.supportsVision ? 1 : 0, isDefault: form.isDefault ? 1 : 0 }
    // 语音/文生图模型不参与默认模型与上下文压缩，强制归零
    if (form.modelType !== 'text') {
      payload.supportsVision = 0
      payload.isDefault = 0
    }
    // In edit mode, omit apiKey when left blank so the existing key is preserved.
    if (isEdit.value && !form.apiKey) {
      delete payload.apiKey
    }
    if (isEdit.value && props.modelData?.id) {
      await api.put(`/models/${props.modelData.id}`, payload)
      ElMessage.success('模型更新成功')
    } else {
      await api.post('/models', payload)
      ElMessage.success(props.mode === 'copy' ? '模型复制成功' : '模型添加成功')
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
