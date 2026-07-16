<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="760px"
    @close="$emit('update:visible', false)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="110px"
      label-position="right"
    >
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="请输入 Agent 名称" />
      </el-form-item>
      <el-form-item label="描述" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="3" placeholder="请输入描述" />
      </el-form-item>
      <el-form-item label="角色定义" prop="systemPrompt">
        <el-input
          v-model="form.systemPrompt"
          type="textarea"
          :rows="5"
          placeholder="请输入角色定义：身份、目标、工作内容、表达方式等"
        />
      </el-form-item>
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
              <el-button
                link
                type="primary"
                :disabled="index === 0"
                @click="moveExperience(index, -1)"
              >上移</el-button>
              <el-button
                link
                type="primary"
                :disabled="index === form.experiences.length - 1"
                @click="moveExperience(index, 1)"
              >下移</el-button>
              <el-button link type="danger" @click="removeExperience(index)">删除</el-button>
            </div>
          </div>
          <el-button type="primary" link @click="addExperience">+ 添加经验</el-button>
        </div>
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
      <el-form-item label="默认 Agent">
        <el-switch v-model="form.isDefault" />
        <span class="form-hint">开启后，新建会话未指定 Agent 时将使用该智能体</span>
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
const formRef = ref<FormInstance>()
const skillDocs = ref<any[]>([])
let experienceKeySeq = 0

const form = reactive({
  name: '',
  description: '',
  systemPrompt: '',
  skillNames: [] as string[],
  tags: [] as string[],
  experiences: [] as ExperienceFormItem[],
  isDefault: false
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
    name: '',
    description: '',
    systemPrompt: '',
    skillNames: [],
    tags: [],
    experiences: [],
    isDefault: false
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
  await loadOptions()
  if (props.agentData) {
    Object.assign(form, {
      name: props.mode === 'copy' ? `${props.agentData.name || ''} - 副本` : props.agentData.name || '',
      description: props.agentData.description || '',
      systemPrompt: props.agentData.systemPrompt || '',
      skillNames: props.agentData.skillNames || [],
      tags: props.agentData.tags || [],
      experiences: mapExperiences(props.agentData.experiences, props.mode === 'edit'),
      isDefault: props.mode === 'copy' ? false : !!props.agentData.isDefault
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
  if (!validateExperiences()) return

  const payload = {
    name: form.name,
    description: form.description,
    systemPrompt: form.systemPrompt,
    skillNames: form.skillNames,
    tags: form.tags,
    isDefault: form.isDefault ? 1 : 0,
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
