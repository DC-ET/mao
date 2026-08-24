<template>
  <div class="mcp-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>MCP 服务器管理</span>
          <div class="header-actions">
            <el-button type="primary" @click="openCreate">新增服务器</el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="keyword"
                clearable
                placeholder="名称 / 描述"
                style="width: 220px"
                @input="loadData()"
              />
            </el-form-item>
          </template>
          <el-form-item label="状态">
            <el-select v-model="statusFilter" clearable placeholder="全部" style="width: 140px" @change="loadData()">
              <el-option label="启用" value="ENABLED" />
              <el-option label="停用" value="DISABLED" />
            </el-select>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="servers" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="name" label="名称" width="160" />
        <el-table-column label="归属" width="120">
          <template #default="{ row }">
            <span v-if="!isUserServer(row)">全局</span>
            <el-tag v-else size="small" type="info">{{ row.userName || '用户' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.serverType === 'STDIO' ? 'warning' : 'primary'" size="small">
              {{ row.serverType }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="连接" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <code class="conn-text">{{ connectionSummary(row) }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ENABLED' ? 'success' : 'info'" size="small">
              {{ row.status === 'ENABLED' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <!-- 用户私有服务器仅提供治理操作（停用/启用/删除），不展示配置 -->
            <template v-if="isUserServer(row)">
              <el-button
                :type="row.status === 'ENABLED' ? 'warning' : 'success'"
                link
                size="small"
                @click="toggleStatus(row)"
              >
                {{ row.status === 'ENABLED' ? '停用' : '启用' }}
              </el-button>
              <el-popconfirm
                :title="`确认删除用户「${row.userName || '未知'}」的服务器「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDelete(row)"
              >
                <template #reference>
                  <el-button type="danger" link size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
            <!-- 全局服务器提供完整管理能力 -->
            <template v-else>
              <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
              <el-button type="primary" link size="small" @click="openTest(row)">测试连接</el-button>
              <el-button link size="small" @click="openTools(row)">查看工具</el-button>
              <el-button
                :type="row.status === 'ENABLED' ? 'warning' : 'success'"
                link
                size="small"
                @click="toggleStatus(row)"
              >
                {{ row.status === 'ENABLED' ? '停用' : '启用' }}
              </el-button>
              <el-popconfirm
                :title="`确认删除「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDelete(row)"
              >
                <template #reference>
                  <el-button type="danger" link size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in servers" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="row.status === 'ENABLED' ? 'success' : 'info'" size="small">
              {{ row.status === 'ENABLED' ? '启用' : '停用' }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">归属</span>
            <span v-if="!isUserServer(row)">全局</span>
            <el-tag v-else size="small" type="info">{{ row.userName || '用户' }}</el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">类型</span>
            <el-tag :type="row.serverType === 'STDIO' ? 'warning' : 'primary'" size="small">
              {{ row.serverType }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">连接</span>
            <code class="conn-text">{{ connectionSummary(row) }}</code>
          </div>
          <div class="mobile-card-actions">
            <template v-if="isUserServer(row)">
              <el-button :type="row.status === 'ENABLED' ? 'warning' : 'success'" link @click="toggleStatus(row)">
                {{ row.status === 'ENABLED' ? '停用' : '启用' }}
              </el-button>
              <el-popconfirm
                :title="`确认删除用户「${row.userName || '未知'}」的服务器「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDelete(row)"
              >
                <template #reference>
                  <el-button type="danger" link>删除</el-button>
                </template>
              </el-popconfirm>
            </template>
            <template v-else>
              <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
              <el-button type="primary" link @click="openTest(row)">测试</el-button>
              <el-button link @click="openTools(row)">工具</el-button>
              <el-button :type="row.status === 'ENABLED' ? 'warning' : 'success'" link @click="toggleStatus(row)">
                {{ row.status === 'ENABLED' ? '停用' : '启用' }}
              </el-button>
              <el-popconfirm
                :title="`确认删除「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDelete(row)"
              >
                <template #reference>
                  <el-button type="danger" link>删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </div>
        </el-card>
        <el-empty v-if="!loading && servers.length === 0" description="暂无数据" />
      </div>
    </el-card>

    <!-- Create / Edit dialog -->
    <ResponsiveDialog
      v-if="formVisible"
      v-model="formVisible"
      :title="isEdit ? '编辑 MCP 服务器' : '新增 MCP 服务器'"
      width="680px"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="110px" label-position="right">
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="唯一标识，作为工具名前缀，如 filesystem、github（小写字母/数字/下划线/连字符）"
          />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="服务器用途说明" />
        </el-form-item>
        <el-form-item label="类型" prop="serverType">
          <el-radio-group v-model="form.serverType">
            <el-radio value="STDIO">STDIO（本地子进程）</el-radio>
            <el-radio value="HTTP">HTTP/SSE（远程 URL）</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="form.serverType === 'STDIO'">
          <el-form-item label="启动命令" prop="command">
            <el-input v-model="form.command" placeholder="如 npx、uvx、node" />
          </el-form-item>
          <el-form-item label="启动参数" prop="args">
            <div class="args-editor">
              <div v-for="index in form.args.length" :key="index" class="arg-row">
                <el-input v-model="form.args[index - 1]" :placeholder="`参数 ${index}`" />
                <el-button link type="danger" :disabled="form.args.length <= 1" @click="form.args.splice(index - 1, 1)">移除</el-button>
              </div>
              <el-button type="primary" link @click="form.args.push('')">+ 添加参数</el-button>
            </div>
          </el-form-item>
        </template>
        <el-form-item v-else label="服务器 URL" prop="url">
          <el-input v-model="form.url" placeholder="https://mcp.example.com/sse 或 streamable http 地址" />
        </el-form-item>

        <el-form-item label="环境变量">
          <div class="env-editor">
            <div v-for="(item, index) in form.envList" :key="index" class="env-row">
              <el-input v-model="item.key" placeholder="变量名" class="env-key" />
              <el-input v-model="item.value" type="password" show-password placeholder="变量值" class="env-value" />
              <el-button link type="danger" @click="form.envList.splice(index, 1)">移除</el-button>
            </div>
            <el-button type="primary" link @click="form.envList.push({ key: '', value: '' })">+ 添加环境变量</el-button>
            <div class="form-hint">环境变量整体加密存储；LOCAL 模式下下发给桌面端用于启动本地进程。</div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </ResponsiveDialog>

    <!-- Test connection dialog -->
    <ResponsiveDialog
      v-if="testVisible"
      v-model="testVisible"
      :title="`测试连接：${currentServer?.name || ''}`"
      width="720px"
    >
      <div v-loading="testing" class="test-content">
        <template v-if="!testing">
          <el-alert
            v-if="testError"
            :title="testError"
            type="error"
            :closable="false"
            show-icon
          />
          <template v-else>
            <el-alert
              :title="`连接成功，该服务器暴露 ${testTools.length} 个工具`"
              type="success"
              :closable="false"
              show-icon
            />
            <el-table :data="testTools" stripe size="small" style="margin-top: 12px" max-height="400">
              <el-table-column prop="toolName" label="工具名" width="200" />
              <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
            </el-table>
          </template>
        </template>
      </div>
      <template #footer>
        <el-button @click="testVisible = false">关闭</el-button>
      </template>
    </ResponsiveDialog>

    <!-- View tools dialog -->
    <ResponsiveDialog
      v-if="toolsVisible"
      v-model="toolsVisible"
      :title="`工具清单：${currentServer?.name || ''}`"
      width="720px"
    >
      <div v-loading="toolsLoading" class="test-content">
        <template v-if="!toolsLoading">
          <el-alert
            v-if="toolsError"
            :title="toolsError"
            type="error"
            :closable="false"
            show-icon
          />
          <el-table v-else :data="toolsList" stripe size="small" max-height="420">
            <template #empty>
              <el-empty description="服务器未暴露任何工具" :image-size="60" />
            </template>
            <el-table-column prop="toolName" label="工具名" width="200" />
            <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
            <el-table-column label="参数" min-width="200">
              <template #default="{ row }">
                <code class="conn-text">{{ schemaSummary(row.inputSchema) }}</code>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </div>
      <template #footer>
        <el-button @click="toolsVisible = false">关闭</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import FilterPanel from '../../components/FilterPanel.vue'

const { isMobile } = useBreakpoint()

interface EnvItem {
  key: string
  value: string
}

const loading = ref(false)
const servers = ref<any[]>([])
const keyword = ref('')
const statusFilter = ref('')

const formVisible = ref(false)
const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const editingId = ref<number | null>(null)

const form = reactive({
  name: '',
  description: '',
  serverType: 'STDIO',
  command: '',
  args: [] as string[],
  url: '',
  envList: [] as EnvItem[]
})

const formRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  serverType: [{ required: true, message: '请选择类型', trigger: 'change' }],
  command: [{
    validator: (_rule, value, callback) => {
      if (form.serverType === 'STDIO' && !value) callback(new Error('STDIO 类型必须填写启动命令'))
      else callback()
    },
    trigger: 'blur'
  }],
  url: [{
    validator: (_rule, value, callback) => {
      if (form.serverType === 'HTTP' && !value) callback(new Error('HTTP 类型必须填写服务器 URL'))
      else callback()
    },
    trigger: 'blur'
  }]
}

const currentServer = ref<any>(null)
const testVisible = ref(false)
const testing = ref(false)
const testError = ref('')
const testTools = ref<any[]>([])

const toolsVisible = ref(false)
const toolsLoading = ref(false)
const toolsError = ref('')
const toolsList = ref<any[]>([])

async function loadData() {
  loading.value = true
  try {
    const { data } = await api.get('/mcp-servers', {
      params: { keyword: keyword.value || undefined, status: statusFilter.value || undefined }
    })
    servers.value = data || []
  } finally {
    loading.value = false
  }
}

function connectionSummary(row: any) {
  if (row.serverType === 'STDIO') {
    const args = safeParseArray(row.argsJson)
    return [row.command, ...args].join(' ')
  }
  return row.url || ''
}

/** 是否为用户私有服务器（userId 非 0）。 */
function isUserServer(row: any) {
  return row.userId != null && row.userId !== 0
}

function schemaSummary(schema: any) {
  if (!schema) return ''
  const props = schema.properties ? Object.keys(schema.properties) : []
  const required = schema.required || []
  const reqMark = (name: string) => (required.includes(name) ? '*' : '')
  return props.length > 0 ? props.map((p) => `${p}${reqMark(p)}`).join(', ') : '{}'
}

function safeParseArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function envToMap(envList: EnvItem[]) {
  const map: Record<string, string> = {}
  for (const item of envList) {
    const key = (item.key || '').trim()
    if (key) map[key] = item.value || ''
  }
  return map
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  Object.assign(form, {
    name: '',
    description: '',
    serverType: 'STDIO',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    url: '',
    envList: []
  })
  formVisible.value = true
}

function openEdit(row: any) {
  isEdit.value = true
  editingId.value = row.id
  Object.assign(form, {
    name: row.name,
    description: row.description || '',
    serverType: row.serverType,
    command: row.command || '',
    args: safeParseArray(row.argsJson),
    url: row.url || '',
    envList: []
  })
  // 编辑时环境变量不回传明文（安全策略），用户可重新填写；为空则保持原值
  formVisible.value = true
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload = {
    name: form.name.trim(),
    description: form.description,
    serverType: form.serverType,
    command: form.serverType === 'STDIO' ? form.command : undefined,
    args: form.serverType === 'STDIO' ? form.args.map((a) => a.trim()).filter(Boolean) : undefined,
    url: form.serverType === 'HTTP' ? form.url.trim() : undefined,
    env: Object.keys(envToMap(form.envList)).length > 0 ? envToMap(form.envList) : undefined
  }

  submitting.value = true
  try {
    if (isEdit.value && editingId.value != null) {
      await api.put(`/mcp-servers/${editingId.value}`, payload)
      ElMessage.success('MCP 服务器更新成功')
    } else {
      await api.post('/mcp-servers', payload)
      ElMessage.success('MCP 服务器创建成功')
    }
    formVisible.value = false
    await loadData()
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(row: any) {
  const next = row.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
  await api.put(`/mcp-servers/${row.id}/status`, { status: next })
  ElMessage.success(next === 'ENABLED' ? '已启用' : '已停用')
  await loadData()
}

async function handleDelete(row: any) {
  await api.delete(`/mcp-servers/${row.id}`)
  ElMessage.success('删除成功')
  await loadData()
}

async function openTest(row: any) {
  currentServer.value = row
  testVisible.value = true
  testError.value = ''
  testTools.value = []
  testing.value = true
  try {
    const { data } = await api.post(`/mcp-servers/${row.id}/test`)
    testTools.value = data || []
  } catch (e: any) {
    testError.value = e?.message || '连接失败'
  } finally {
    testing.value = false
  }
}

async function openTools(row: any) {
  currentServer.value = row
  toolsVisible.value = true
  toolsError.value = ''
  toolsList.value = []
  toolsLoading.value = true
  try {
    const { data } = await api.post(`/mcp-servers/${row.id}/test`)
    toolsList.value = data || []
  } catch (e: any) {
    toolsError.value = e?.message || '无法获取工具清单'
  } finally {
    toolsLoading.value = false
  }
}

loadData()
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.search-form {
  margin-bottom: 4px;
}

.conn-text {
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.args-editor,
.env-editor {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.arg-row,
.env-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.arg-row .el-input {
  flex: 1;
}

.env-key {
  width: 200px;
}

.env-value {
  flex: 1;
}

.form-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.test-content {
  min-height: 60px;
}
</style>
