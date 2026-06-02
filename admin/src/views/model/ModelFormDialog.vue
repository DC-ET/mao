<template>
  <el-dialog
    :model-value="visible"
    :title="isEdit ? '编辑模型' : '添加模型'"
    width="580px"
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
        <el-input v-model="form.apiKey" type="password" show-password placeholder="请输入 API Key" />
      </el-form-item>
      <el-form-item label="支持视觉">
        <el-switch v-model="form.supportsVision" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px;">开启后可在任务中发送图片</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ isEdit ? '保存' : '添加' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const props = defineProps<{
  visible: boolean
  modelData?: any | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  name: '',
  provider: '',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  supportsVision: false
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
  modelId: [{ required: true, message: '请输入模型标识', trigger: 'blur' }]
}

watch(() => props.visible, (val) => {
  if (!val) return
  if (props.modelData) {
    isEdit.value = true
    Object.assign(form, {
      name: props.modelData.name || '',
      provider: props.modelData.provider || '',
      modelId: props.modelData.modelId || '',
      baseUrl: props.modelData.baseUrl || '',
      apiKey: '',
      supportsVision: !!props.modelData.supportsVision
    })
  } else {
    isEdit.value = false
    Object.assign(form, {
      name: '',
      provider: '',
      modelId: '',
      baseUrl: '',
      apiKey: '',
      supportsVision: false
    })
  }
})

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const payload: any = { ...form, supportsVision: form.supportsVision ? 1 : 0 }
    if (isEdit.value && !payload.apiKey) {
      delete (payload as any).apiKey
    }
    if (isEdit.value && props.modelData?.id) {
      await api.put(`/models/${props.modelData.id}`, payload)
      ElMessage.success('模型更新成功')
    } else {
      await api.post('/models', payload)
      ElMessage.success('模型添加成功')
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
