<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
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
        {{ submitButtonText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, reactive } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

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
const formRef = ref<FormInstance>()
const skillDocs = ref<any[]>([])

const form = reactive({
  name: '',
  description: '',
  systemPrompt: '',
  skillNames: [] as string[],
  tags: [] as string[]
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入 Agent 名称', trigger: 'blur' }],
  systemPrompt: [{ required: true, message: '请输入系统提示词', trigger: 'blur' }]
}

function resetForm() {
  Object.assign(form, {
    name: '',
    description: '',
    systemPrompt: '',
    skillNames: [],
    tags: []
  })
}

watch(() => props.visible, async (val) => {
  if (!val) return
  await loadOptions()
  if (props.agentData) {
    Object.assign(form, {
      name: props.mode === 'copy' ? `${props.agentData.name || ''} - 副本` : props.agentData.name || '',
      description: props.agentData.description || '',
      systemPrompt: props.agentData.systemPrompt || '',
      skillNames: props.agentData.skillNames || [],
      tags: props.agentData.tags || []
    })
  } else {
    resetForm()
  }

  formRef.value?.clearValidate()
})

async function loadOptions() {
  const { data } = await api.get('/skill-docs')
  skillDocs.value = data || []
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
