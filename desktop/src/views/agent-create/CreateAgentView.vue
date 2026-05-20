<template>
  <div class="create-agent">
    <el-card>
      <template #header>
        <h2>创建个人 Agent</h2>
      </template>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="120px"
        class="agent-form"
      >
        <!-- Basic info -->
        <el-divider content-position="left">基本信息</el-divider>

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

        <!-- Personality -->
        <el-divider content-position="left">人格设定</el-divider>

        <el-form-item label="系统提示词" prop="systemPrompt">
          <el-input
            v-model="form.systemPrompt"
            type="textarea"
            :rows="6"
            placeholder="定义你的 Agent 的人格、能力和行为方式..."
          />
        </el-form-item>

        <!-- Model -->
        <el-divider content-position="left">模型配置</el-divider>

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

        <!-- Skills -->
        <el-divider content-position="left">Skills 配置</el-divider>

        <el-form-item label="可用 Skills">
          <el-transfer
            v-model="form.skillIds"
            :data="skills"
            :titles="['可用 Skills', '已选择']"
            :props="{ key: 'id', label: 'name' }"
          />
        </el-form-item>

        <!-- MCP -->
        <el-divider content-position="left">MCP 配置</el-divider>

        <el-form-item
          v-for="(config, index) in form.mcpConfigs"
          :key="index"
          :label="'MCP Server ' + (index + 1)"
        >
          <el-row :gutter="12">
            <el-col :span="12">
              <el-input v-model="config.serverUrl" placeholder="MCP Server URL" />
            </el-col>
            <el-col :span="8">
              <el-select v-model="config.transport" placeholder="传输方式">
                <el-option label="SSE" value="SSE" />
                <el-option label="STDIO" value="STDIO" />
              </el-select>
            </el-col>
            <el-col :span="4">
              <el-button type="danger" @click="handleRemoveMcp(index)">删除</el-button>
            </el-col>
          </el-row>
        </el-form-item>

        <el-form-item>
          <el-button @click="handleAddMcp">添加 MCP Server</el-button>
        </el-form-item>

        <!-- Visibility -->
        <el-divider content-position="left">可见性</el-divider>

        <el-form-item label="可见范围">
          <el-radio-group v-model="form.visibility">
            <el-radio value="PRIVATE">仅自己可见</el-radio>
            <el-radio value="HUB">发布到 Hub</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- Submit -->
        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">
            {{ form.visibility === 'HUB' ? '创建并发布' : '创建' }}
          </el-button>
          <el-button @click="handleCancel">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
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
  skillIds: [] as number[],
  mcpConfigs: [] as { serverUrl: string; transport: string }[],
  visibility: 'PRIVATE',
  tags: [] as string[]
})

const models = ref<any[]>([])
const skills = ref<any[]>([])
const availableTags = ref(['编程', '写作', '分析', '翻译', '客服', '其他'])

const rules: FormRules = {
  name: [{ required: true, message: '请输入 Agent 名称', trigger: 'blur' }],
  systemPrompt: [{ required: true, message: '请输入系统提示词', trigger: 'blur' }],
  modelId: [{ required: true, message: '请选择模型', trigger: 'change' }]
}

async function fetchData() {
  try {
    const [modelRes, skillRes] = await Promise.all([
      api.get('/models'),
      api.get('/skills')
    ])
    models.value = modelRes.data || []
    skills.value = skillRes.data || []
  } catch {
    // Error handled by interceptor
  }
}

function handleIconSuccess(response: any) {
  form.value.iconUrl = response.data?.url || ''
}

function handleAddMcp() {
  form.value.mcpConfigs.push({ serverUrl: '', transport: 'SSE' })
}

function handleRemoveMcp(index: number) {
  form.value.mcpConfigs.splice(index, 1)
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await api.post('/agents', form.value)
    ElMessage.success('创建成功')
    router.push('/workbench')
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
  padding: 20px 0;
}

.agent-form {
  max-width: 800px;
}

.icon-uploader :deep(.el-upload) {
  border: 1px dashed #d9d9d9;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.3s;
}

.icon-uploader :deep(.el-upload:hover) {
  border-color: #409eff;
}

.icon-uploader-icon {
  font-size: 28px;
  color: #8c939d;
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
