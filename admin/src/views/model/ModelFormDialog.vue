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
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="例如: GPT-4o, Claude Opus" />
      </el-form-item>
      <el-form-item label="供应商" prop="provider">
        <el-input v-model="form.provider" placeholder="例如: OpenAI, Anthropic" />
      </el-form-item>
      <el-form-item label="模型标识" prop="modelId">
        <el-input v-model="form.modelId" placeholder="例如: gpt-4o, claude-opus-4-6" />
      </el-form-item>
      <el-form-item label="API 地址" prop="baseUrl">
        <el-input v-model="form.baseUrl" placeholder="例如: https://api.openai.com/v1" />
      </el-form-item>
      <el-form-item label="API Key" prop="apiKey">
        <el-input v-model="form.apiKey" type="password" show-password :placeholder="isEdit ? '留空则不修改' : '请输入 API Key'" />
      </el-form-item>
      <el-form-item label="上下文窗口">
        <el-input-number
          v-model="form.contextWindowTokens"
          :min="1024"
          :max="2000000"
          :step="1024"
          style="width: 220px"
        />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">用于上下文压缩水位展示</span>
      </el-form-item>
      <el-form-item label="支持视觉">
        <el-switch v-model="form.supportsVision" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">开启后可在任务中发送图片</span>
      </el-form-item>
      <el-form-item label="默认模型">
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
}>(), {
  modelData: null,
  mode: 'create'
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
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  name: '',
  provider: '',
  modelId: '',
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
    name: '',
    provider: '',
    modelId: '',
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
      name: props.mode === 'copy' ? `${props.modelData.name || ''} - 副本` : props.modelData.name || '',
      provider: props.modelData.provider || '',
      modelId: props.modelData.modelId || '',
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
