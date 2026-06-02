<template>
  <el-dialog
    :model-value="visible"
    :title="isEdit ? '编辑 Agent' : '创建 Agent'"
    width="680px"
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
        <el-input v-model="form.name" placeholder="请输入 Agent 名称" />
      </el-form-item>
      <el-form-item label="描述" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="3" placeholder="请输入描述" />
      </el-form-item>
      <el-form-item label="系统提示词" prop="systemPrompt">
        <el-input v-model="form.systemPrompt" type="textarea" :rows="5" placeholder="请输入系统提示词" />
      </el-form-item>
      <el-form-item label="模型" prop="modelId">
        <el-select v-model="form.modelId" placeholder="请选择模型" style="width: 100%">
          <el-option
            v-for="m in models"
            :key="m.id"
            :label="m.name"
            :value="m.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="可见性" prop="visibility">
        <el-select v-model="form.visibility" placeholder="请选择可见性" style="width: 100%">
          <el-option label="私有" value="PRIVATE" />
          <el-option label="公开" value="PUBLIC" />
        </el-select>
      </el-form-item>
      <el-form-item label="图标 URL" prop="iconUrl">
        <el-input v-model="form.iconUrl" placeholder="请输入图标 URL" />
      </el-form-item>
      <el-form-item label="Token 上限" prop="tokenLimit">
        <el-input-number v-model="form.tokenLimit" :min="0" :max="1000000" :step="1000" />
      </el-form-item>
      <el-form-item label="最大轮次" prop="maxRounds">
        <el-input-number v-model="form.maxRounds" :min="1" :max="100" />
      </el-form-item>
      <el-form-item label="关联 Skills" prop="skillNames">
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
      <el-form-item label="标签" prop="tags">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          placeholder="输入标签后回车确认"
          style="width: 100%"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ isEdit ? '保存' : '创建' }}
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
  agentData?: any | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const models = ref<any[]>([])
const skillDocs = ref<any[]>([])

const form = reactive({
  name: '',
  description: '',
  systemPrompt: '',
  modelId: null as number | null,
  visibility: 'PRIVATE',
  iconUrl: '',
  tokenLimit: 4096,
  maxRounds: 10,
  skillNames: [] as string[],
  tags: [] as string[]
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入 Agent 名称', trigger: 'blur' }],
  systemPrompt: [{ required: true, message: '请输入系统提示词', trigger: 'blur' }]
}

watch(() => props.visible, async (val) => {
  if (!val) return
  await loadOptions()
  if (props.agentData) {
    isEdit.value = true
    Object.assign(form, {
      name: props.agentData.name || '',
      description: props.agentData.description || '',
      systemPrompt: props.agentData.systemPrompt || '',
      modelId: props.agentData.modelId || null,
      visibility: props.agentData.visibility || 'PRIVATE',
      iconUrl: props.agentData.iconUrl || '',
      tokenLimit: props.agentData.tokenLimit ?? 4096,
      maxRounds: props.agentData.maxRounds ?? 10,
      skillNames: props.agentData.skillNames || [],
      tags: props.agentData.tags || []
    })
  } else {
    isEdit.value = false
    Object.assign(form, {
      name: '',
      description: '',
      systemPrompt: '',
      modelId: null,
      visibility: 'PRIVATE',
      iconUrl: '',
      tokenLimit: 4096,
      maxRounds: 10,
      skillNames: [],
      tags: []
    })
  }
})

async function loadOptions() {
  const [modelsRes, skillDocsRes] = await Promise.all([
    api.get('/models'),
    api.get('/skill-docs')
  ])
  models.value = (modelsRes as any).data || []
  skillDocs.value = (skillDocsRes as any).data || []
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    if (isEdit.value && props.agentData?.id) {
      await api.put(`/agents/${props.agentData.id}`, form)
      ElMessage.success('Agent 更新成功')
    } else {
      await api.post('/agents', form)
      ElMessage.success('Agent 创建成功')
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
