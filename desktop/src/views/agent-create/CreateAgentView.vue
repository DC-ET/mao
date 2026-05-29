<template>
  <div class="create-agent">
    <div class="create-header">
      <h1 class="create-title">创建个人 Agent</h1>
    </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="120px"
        class="agent-form"
      >
        <!-- Basic info -->
        <div class="form-section">
          <h2 class="section-title">基本信息</h2>

          <el-form-item label="Agent 名称" prop="name">
            <el-input v-model="form.name" placeholder="给你的 Agent 起个名字" />
          </el-form-item>

          <el-form-item label="描述" prop="description">
            <el-input
              v-model="form.description"
              type="textarea"
              :rows="3"
              placeholder="描述你的 Agent 能做什么"
            />
          </el-form-item>

          <el-form-item label="图标">
            <el-upload
              class="icon-uploader"
              action="/api/v1/files/upload"
              :show-file-list="false"
              :on-success="handleIconSuccess"
            >
              <el-avatar v-if="form.iconUrl" :size="80" :src="form.iconUrl" />
              <el-icon v-else class="icon-uploader-icon"><Plus /></el-icon>
            </el-upload>
          </el-form-item>

          <el-form-item label="分类标签">
            <el-select
              v-model="form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="选择或创建标签"
            >
              <el-option
                v-for="tag in availableTags"
                :key="tag"
                :label="tag"
                :value="tag"
              />
            </el-select>
          </el-form-item>
        </div>

        <!-- Personality -->
        <div class="form-section">
          <h2 class="section-title">人格设定</h2>

          <el-form-item label="系统提示词" prop="systemPrompt">
            <el-input
              v-model="form.systemPrompt"
              type="textarea"
              :rows="6"
              placeholder="定义你的 Agent 的人格、能力和行为方式..."
            />
          </el-form-item>
        </div>

        <!-- Model -->
        <div class="form-section">
          <h2 class="section-title">模型配置</h2>

          <el-form-item label="选择模型" prop="modelId">
            <el-select v-model="form.modelId" placeholder="选择 LLM 模型">
              <el-option
                v-for="model in models"
                :key="model.id"
                :label="model.name"
                :value="model.id"
              />
            </el-select>
          </el-form-item>
        </div>

        <!-- Tools -->
        <div class="form-section">
          <h2 class="section-title">Tools 配置</h2>

          <el-form-item label="可用 Tools">
            <el-transfer
              v-model="form.toolIds"
              :data="tools"
              :titles="['可用 Tools', '已选择']"
              :props="{ key: 'id', label: 'name' }"
            />
          </el-form-item>
        </div>

        <!-- Skills -->
        <div class="form-section">
          <h2 class="section-title">Skills 知识文档</h2>

          <el-form-item label="可用 Skills">
            <el-select
              v-model="form.skillNames"
              multiple
              filterable
              placeholder="选择 Skill 知识文档（留空则加载全部）"
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
        </div>

        <!-- Visibility -->
        <div class="form-section">
          <h2 class="section-title">可见性</h2>

          <el-form-item label="可见范围">
            <el-radio-group v-model="form.visibility">
              <el-radio value="PRIVATE">仅自己可见</el-radio>
              <el-radio value="HUB">发布到 Hub</el-radio>
            </el-radio-group>
          </el-form-item>
        </div>

        <!-- Submit -->
        <el-form-item>
          <el-button type="primary" class="pill-btn" :loading="submitting" @click="handleSubmit">
            {{ form.visibility === 'HUB' ? '创建并发布' : '创建' }}
          </el-button>
          <el-button class="pill-btn" @click="handleCancel">取消</el-button>
        </el-form-item>
      </el-form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { api } from '../../api'

const router = useRouter()
const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = ref({
  name: '',
  description: '',
  iconUrl: '',
  systemPrompt: '',
  modelId: null as number | null,
  toolIds: [] as number[],
  skillNames: [] as string[],
  visibility: 'PRIVATE',
  tags: [] as string[]
})

const models = ref<any[]>([])
const tools = ref<any[]>([])
const skillDocs = ref<any[]>([])
const availableTags = ref(['编程', '写作', '分析', '翻译', '客服', '其他'])

const rules: FormRules = {
  name: [{ required: true, message: '请输入 Agent 名称', trigger: 'blur' }],
  systemPrompt: [{ required: true, message: '请输入系统提示词', trigger: 'blur' }],
  modelId: [{ required: true, message: '请选择模型', trigger: 'change' }]
}

async function fetchData() {
  try {
    const [modelRes, toolRes, skillDocRes] = await Promise.all([
      api.get('/models'),
      api.get('/tools'),
      api.get('/skill-docs')
    ])
    models.value = modelRes.data || []
    tools.value = toolRes.data || []
    skillDocs.value = skillDocRes.data || []
  } catch {
    // Error handled by interceptor
  }
}

function handleIconSuccess(response: any) {
  form.value.iconUrl = response.data?.url || ''
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await api.post('/agents', form.value)
    ElMessage.success('创建成功')
    router.push('/')
  } finally {
    submitting.value = false
  }
}

function handleCancel() {
  router.back()
}

onMounted(fetchData)
</script>

<style scoped>
.create-agent {
  padding: var(--aw-space-section) var(--aw-space-xl);
  max-width: 860px;
  margin: 0 auto;
}

.create-header {
  margin-bottom: var(--aw-space-xl);
}

.create-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-display-lg);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0;
  line-height: 1.1;
}

.agent-form {
  max-width: 700px;
}

.form-section {
  margin-bottom: var(--aw-space-xl);
}

.section-title {
  margin: 0 0 var(--aw-space-lg);
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
  padding-bottom: var(--aw-space-xs);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.icon-uploader :deep(.el-upload) {
  border: 1px dashed var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s;
}

.icon-uploader :deep(.el-upload:hover) {
  border-color: var(--aw-primary);
}

.icon-uploader-icon {
  font-size: 28px;
  color: var(--aw-ink-muted-48);
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}
</style>
