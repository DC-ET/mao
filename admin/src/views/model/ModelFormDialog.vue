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
      <el-tabs v-model="activeTab" class="model-form-tabs">
        <el-tab-pane label="基本信息" name="basic">
          <el-form-item label="模型类型" prop="modelType">
            <el-radio-group v-model="form.modelType" :disabled="isEdit">
              <el-radio value="text">文本模型</el-radio>
              <el-radio value="audio">语音模型</el-radio>
              <el-radio value="image">文生图</el-radio>
            </el-radio-group>
            <span v-if="!isEdit" class="form-hint-inline">语音模型用于 TTS 等音频合成，文生图用于图片生成</span>
            <span v-else class="form-hint-inline">编辑时不可切换模型类型</span>
          </el-form-item>
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="例如: GPT-4o, Claude Opus" />
          </el-form-item>
          <el-form-item label="供应商" prop="provider">
            <el-select
              v-model="form.provider"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入供应商，例如: OpenAI, Anthropic"
              style="width: 100%"
            >
              <el-option v-for="provider in providerOptions" :key="provider" :label="provider" :value="provider" />
            </el-select>
          </el-form-item>
          <el-form-item label="模型标识" prop="modelId">
            <el-input v-model="form.modelId" placeholder="例如: gpt-4o, mimo-v2.5-tts" />
          </el-form-item>
          <el-form-item v-if="isTextType" label="上下文窗口">
            <el-input-number
              v-model="form.contextWindowTokens"
              :min="1024"
              :max="2000000"
              :step="1024"
              style="width: 220px"
            />
            <span class="form-hint-inline">用于上下文压缩水位展示</span>
          </el-form-item>
          <el-form-item v-if="isTextType" label="支持视觉">
            <el-switch v-model="form.supportsVision" />
            <span class="form-hint-inline">开启后可在任务中发送图片</span>
          </el-form-item>
          <el-form-item v-if="isTextType" label="默认模型">
            <el-switch v-model="form.isDefault" />
            <span class="form-hint-inline">新会话默认使用此模型</span>
          </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="接入配置" name="access">
          <el-form-item label="客户端标识">
            <el-radio-group v-model="form.clientImpersonation">
              <el-radio value="none">None</el-radio>
              <el-radio value="codex">Codex</el-radio>
              <el-radio value="claude_code">Claude Code</el-radio>
            </el-radio-group>
            <span class="form-hint-inline">调用该模型时模拟的客户端请求头</span>
          </el-form-item>
          <el-form-item label="API 协议">
            <el-select v-model="form.apiProtocol" style="width: 100%">
              <el-option label="OpenAI 兼容（ChatCompletions）" value="openai-compatible" />
              <el-option label="Anthropic（Messages）" value="anthropic" />
              <el-option label="OpenAI（Responses）" value="openai-responses" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="supportsEffort" label="推理力度">
            <el-select v-model="form.effort" style="width: 100%">
              <el-option label="默认（high）" value="" />
              <el-option label="None" value="none" />
              <el-option label="Low" value="low" />
              <el-option label="Medium" value="medium" />
              <el-option label="High" value="high" />
              <el-option label="X-High" value="xhigh" />
              <el-option label="Max" value="max" />
            </el-select>
            <span class="form-hint-inline">控制模型 reasoning token 预算，留空使用协议默认值</span>
          </el-form-item>
          <el-form-item label="API 地址" prop="baseUrl">
            <el-input v-model="form.baseUrl" placeholder="例如: https://api.openai.com/v1">
              <template #append><span class="api-suffix">{{ apiProtocolSuffix }}</span></template>
            </el-input>
          </el-form-item>
          <el-form-item label="API Key" prop="apiKey">
            <el-input v-model="form.apiKey" type="password" show-password :placeholder="isEdit ? '已回填当前 Key，可查看或修改；留空则不修改' : '请输入 API Key'" />
          </el-form-item>
          <el-form-item v-if="isTextType" label="输入价格">
            <el-input-number
              v-model="form.priceInput"
              :min="0"
              :max="PRICE_MAX"
              :step="0.01"
              :precision="6"
              :controls="false"
              placeholder="留空则不计成本"
              style="width: 220px"
            />
            <span class="form-hint-inline">每百万输入 Token 价格（成本单位；仅影响后续调用，不追溯历史）</span>
          </el-form-item>
          <el-form-item v-if="isTextType" label="输出价格">
            <el-input-number
              v-model="form.priceOutput"
              :min="0"
              :max="PRICE_MAX"
              :step="0.01"
              :precision="6"
              :controls="false"
              placeholder="留空则不计成本"
              style="width: 220px"
            />
            <span class="form-hint-inline">每百万输出 Token 价格（成本单位；缓存命中按 5 折计价）</span>
          </el-form-item>
        </el-tab-pane>
      </el-tabs>
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
import { computed, onMounted, ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

/** 价格上限与后端 price_input / price_output 的 DECIMAL(12,6) 值域对齐：el-input-number 的 max
 *  会把超范围输入钳到该值本身，若取 1000000 恰好钳到唯一一个不可存的值而使保存失败。 */
const PRICE_MAX = 999999.999999

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

onMounted(loadProviderOptions)

const isEdit = computed(() => props.mode === 'edit')
const dialogTitle = computed(() => {
  if (props.mode === 'edit') return '编辑模型'
  if (props.mode === 'copy') return '复制模型'
  return '添加模型'
})
const submitButtonText = computed(() => (isEdit.value ? '保存' : '添加'))
const isTextType = computed(() => form.modelType === 'text')
// 推理力度仅对 OpenAI 兼容 / Responses 协议的文本模型有意义，Anthropic 协议不支持该参数
const supportsEffort = computed(() => isTextType.value && form.apiProtocol !== 'anthropic')
// 协议对应的调用路径后缀，与后端各 LLM 适配器实际拼接一致
const apiProtocolSuffix = computed(() => {
  const suffixes: Record<string, string> = {
    'openai-compatible': '/chat/completions',
    anthropic: '/messages',
    'openai-responses': '/responses'
  }
  return suffixes[form.apiProtocol] ?? ''
})
const submitting = ref(false)
const formRef = ref<FormInstance>()
const providerOptions = ref<string[]>([])
const activeTab = ref<'basic' | 'access'>('basic')

const FIELD_TAB: Record<string, 'basic' | 'access'> = {
  modelType: 'basic',
  name: 'basic',
  modelId: 'basic',
  baseUrl: 'access',
  apiKey: 'access'
}

async function loadProviderOptions() {
  try {
    const { data } = await api.get('/models/providers')
    providerOptions.value = data || []
  } catch { /* 拦截器已提示失败，仍可手动输入供应商 */ }
}

// 后端掩码格式固定为 ****xxxx（或 ****），以此区分明文 Key 与掩码串
function isMaskedApiKey(apiKey?: string | null): boolean {
  return !!apiKey && apiKey.startsWith('****')
}

const form = reactive({
  modelType: 'text',
  name: '',
  provider: '',
  apiProtocol: 'openai-compatible',
  effort: '',
  modelId: '',
  clientImpersonation: 'none',
  baseUrl: '',
  apiKey: '',
  contextWindowTokens: 256000,
  priceInput: undefined as number | undefined | null,
  priceOutput: undefined as number | undefined | null,
  supportsVision: false,
  isDefault: false
})

const rules = computed<FormRules>(() => ({
  name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
  modelId: [{ required: true, message: '请输入模型标识', trigger: 'blur' }],
  baseUrl: [
    { required: true, message: '请输入 API 地址', trigger: 'blur' },
    { pattern: /^https?:\/\//, message: '需以 http:// 或 https:// 开头', trigger: 'blur' }
  ],
  apiKey: isEdit.value
    ? []
    : [{ required: true, message: '请输入 API Key', trigger: 'blur' }]
}))

function resetForm() {
  Object.assign(form, {
    modelType: props.defaultType,
    name: '',
    provider: '',
    apiProtocol: 'openai-compatible',
    effort: '',
    modelId: '',
    clientImpersonation: 'none',
    baseUrl: '',
    apiKey: '',
    contextWindowTokens: 256000,
    priceInput: null,
    priceOutput: null,
    supportsVision: false,
    isDefault: false
  })
}

watch(() => props.visible, (val) => {
  if (!val) return
  activeTab.value = 'basic'
  if (props.modelData) {
    Object.assign(form, {
      modelType: props.modelData.modelType || 'text',
      name: props.mode === 'copy' ? `${props.modelData.name || ''} - 副本` : props.modelData.name || '',
      provider: props.modelData.provider || '',
      apiProtocol: props.modelData.apiProtocol || 'openai-compatible',
      effort: props.modelData.effort || '',
      modelId: props.modelData.modelId || '',
      clientImpersonation: props.modelData.clientImpersonation || 'none',
      baseUrl: props.modelData.baseUrl || '',
      // 编辑/复制按钮仅对 model:write 可见，该权限下后端返回明文 Key，直接回填
      // 供查看与复制；掩码串（****xxxx，无权限/旧数据）不回填，以免原样提交把
      // 掩码写成新密钥导致模型调用全部鉴权失败。编辑时留空 = 不修改，由后端保留原值。
      apiKey: isMaskedApiKey(props.modelData.apiKey) ? '' : props.modelData.apiKey || '',
      contextWindowTokens: props.modelData.contextWindowTokens || 256000,
      priceInput: props.modelData.priceInput ?? null,
      priceOutput: props.modelData.priceOutput ?? null,
      supportsVision: !!props.modelData.supportsVision,
      isDefault: !!props.modelData.isDefault
    })
  } else {
    resetForm()
  }

  formRef.value?.clearValidate()
}, { immediate: true })

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch((fields: Record<string, unknown>) => {
    const first = Object.keys(fields ?? {})[0]
    if (first && FIELD_TAB[first]) activeTab.value = FIELD_TAB[first]
    return false
  })
  if (!valid) return

  // 防御：掩码串不应被当作新密钥提交
  if (isMaskedApiKey(form.apiKey)) {
    activeTab.value = 'access'
    ElMessage.error('API Key 含掩码字符，请重新填写完整密钥')
    return
  }

  submitting.value = true
  try {
    const payload: any = { ...form, supportsVision: form.supportsVision ? 1 : 0, isDefault: form.isDefault ? 1 : 0 }
    // 语音/文生图模型不参与默认模型与上下文压缩，强制归零；价格同样不参与成本核算
    if (form.modelType !== 'text') {
      payload.supportsVision = 0
      payload.isDefault = 0
      payload.priceInput = null
      payload.priceOutput = null
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

<style scoped>
.model-form-tabs :deep(.el-tabs__header) {
  margin-bottom: 18px;
}
.api-suffix {
  font-family: monospace;
}
</style>
