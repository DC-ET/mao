<template>
  <div class="mcp-servers-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">MCP 服务器</h1>
        <p class="page-desc">
          在此新增和管理你自己的 MCP 服务器，并选择会话中启用的服务器。
          新增的服务器自动注入你的会话；关闭后，你的会话将不再注入该服务器暴露的工具。
        </p>
      </div>
    </header>

    <div v-if="loading" class="empty-state">加载中...</div>

    <template v-else>
      <!-- ── 我的服务器 ── -->
      <section class="section-block">
        <div class="section-header">
          <h2 class="section-title">我的服务器</h2>
          <el-button type="primary" size="small" @click="openCreate">新增服务器</el-button>
        </div>
        <p class="page-hint">
          私有服务器仅你自己可见，自动注入你的全部会话；环境变量加密存储，不与管理员共享。
        </p>

        <div v-if="myServers.length === 0" class="empty-state">
          暂无自定义服务器，点击「新增服务器」接入你自己的 MCP 服务。
        </div>

        <div v-else class="server-list">
          <div v-for="server in myServers" :key="server.id" class="server-card">
            <div class="server-info">
              <div class="server-name-row">
                <span class="server-name">{{ server.name }}</span>
                <el-tag :type="server.serverType === 'STDIO' ? 'warning' : 'primary'" size="small">
                  {{ server.serverType }}
                </el-tag>
                <el-tag v-if="server.status === 'DISABLED'" type="danger" size="small">
                  已被管理员停用
                </el-tag>
              </div>
              <div v-if="server.description" class="server-desc">{{ server.description }}</div>
            </div>
            <div class="server-actions">
              <el-button link size="small" @click="openEdit(server)">编辑</el-button>
              <el-button link size="small" :loading="testingId === server.id" @click="handleTest(server)">
                测试连接
              </el-button>
              <el-popconfirm
                :title="`确认删除「${server.name}」？删除后无法恢复。`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDelete(server)"
              >
                <template #reference>
                  <el-button link type="danger" size="small">删除</el-button>
                </template>
              </el-popconfirm>
              <el-switch
                :model-value="server.userEnabled"
                :disabled="server.status === 'DISABLED'"
                :loading="savingId === server.id"
                @change="(val: string | number | boolean) => handleToggle(server, !!val)"
              />
            </div>
          </div>
        </div>
      </section>

      <!-- ── 全局服务器 ── -->
      <section v-if="globalServers.length > 0" class="section-block">
        <div class="section-header">
          <h2 class="section-title">全局服务器</h2>
        </div>
        <p class="page-hint">由管理员统一维护的 MCP 服务器，此处仅控制启用开关。</p>
        <div class="server-list">
          <div v-for="server in globalServers" :key="server.id" class="server-card">
            <div class="server-info">
              <div class="server-name-row">
                <span class="server-name">{{ server.name }}</span>
                <el-tag :type="server.serverType === 'STDIO' ? 'warning' : 'primary'" size="small">
                  {{ server.serverType }}
                </el-tag>
              </div>
              <div v-if="server.description" class="server-desc">{{ server.description }}</div>
            </div>
            <el-switch
              :model-value="server.userEnabled"
              :loading="savingId === server.id"
              @change="(val: string | number | boolean) => handleToggle(server, !!val)"
            />
          </div>
        </div>
      </section>

      <p class="page-hint">停用仅影响你本人的会话；管理员全局停用的服务器不会出现在此列表。</p>
    </template>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog
      v-model="formVisible"
      :title="isEdit ? `编辑服务器：${form.name}` : '新增 MCP 服务器'"
      width="640px"
      class="mcp-server-dialog management-dialog"
      :close-on-click-modal="false"
      @closed="onFormDialogClosed"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="唯一标识，作为工具名前缀，如 myfiles（小写字母/数字/下划线/连字符）"
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
              <div v-for="(_arg, index) in form.args" :key="index" class="arg-row">
                <el-input v-model="form.args[index]" :placeholder="`参数 ${index + 1}`" />
                <el-button link type="danger" :disabled="form.args.length <= 1" @click="form.args.splice(index, 1)">
                  移除
                </el-button>
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
            <div class="form-hint">
              环境变量加密存储；编辑时不显示已保存的值，留空则保留原值。
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 测试连接结果弹窗 -->
    <el-dialog
      v-model="testVisible"
      :title="`测试连接：${currentServer?.name || ''}`"
      width="640px"
      class="management-dialog"
    >
      <div v-loading="testing" class="test-content">
        <template v-if="!testing">
          <el-alert v-if="testError" :title="testError" type="error" :closable="false" show-icon />
          <template v-else>
            <el-alert
              :title="`连接成功，该服务器暴露 ${testTools.length} 个工具`"
              type="success"
              :closable="false"
              show-icon
            />
            <el-table v-if="testTools.length > 0" :data="testTools" stripe size="small" style="margin-top: 12px" max-height="360">
              <el-table-column prop="toolName" label="工具名" width="220" />
              <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
            </el-table>
          </template>
        </template>
      </div>
      <template #footer>
        <el-button @click="testVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  getMcpServerPreferences,
  saveMcpServerPreference,
  getMyMcpServers,
  createMyMcpServer,
  updateMyMcpServer,
  deleteMyMcpServer,
  testMyMcpServer,
  type McpServerPreferenceItem,
  type McpServerConfig,
  type McpToolItem
} from '../../api'

const loading = ref(true)
const savingId = ref<number | null>(null)
/** 私有服务器：完整配置 + 用户级启用状态 */
type MyMcpServer = McpServerConfig & { userEnabled: boolean }
const myServers = ref<MyMcpServer[]>([])
const globalServers = ref<McpServerPreferenceItem[]>([])

interface EnvItem {
  key: string
  value: string
}

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
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' },
    {
      pattern: /^[a-z0-9_-]+$/,
      message: '仅支持小写字母、数字、下划线和连字符',
      trigger: 'blur'
    },
    {
      validator: (_rule, value, callback) => {
        if (value && value.includes('__')) callback(new Error('名称不能包含连续下划线（__）'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  serverType: [{ required: true, message: '请选择类型', trigger: 'change' }],
  command: [
    {
      validator: (_rule, value, callback) => {
        if (form.serverType === 'STDIO' && !value) callback(new Error('STDIO 类型必须填写启动命令'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  url: [
    {
      validator: (_rule, value, callback) => {
        if (form.serverType === 'HTTP' && !value) callback(new Error('HTTP 类型必须填写服务器 URL'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

const currentServer = ref<McpServerConfig | null>(null)
const testVisible = ref(false)
const testing = ref(false)
const testError = ref('')
const testTools = ref<McpToolItem[]>([])
const testingId = ref<number | null>(null)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [prefs, mine] = await Promise.all([getMcpServerPreferences(), getMyMcpServers()])
    // 偏好列表按 scope 分块展示；私有服务器保留完整配置（command/argsJson/url）供编辑回填
    globalServers.value = (prefs || []).filter((s) => s.scope === 'GLOBAL')
    const prefMap = new Map<number, McpServerPreferenceItem>()
    ;(prefs || []).forEach((s) => prefMap.set(s.id, s))
    myServers.value = (mine || []).map((cfg) => {
      const pref = prefMap.get(cfg.id)
      return {
        ...cfg,
        userEnabled: pref ? pref.userEnabled : cfg.status === 'ENABLED'
      }
    })
  } catch {
    // 拦截器已统一 toast，这里避免 unhandledrejection
  } finally {
    loading.value = false
  }
}

async function handleToggle(server: { id: number; name: string; userEnabled: boolean }, enabled: boolean) {
  // 乐观更新
  const previous = server.userEnabled
  server.userEnabled = enabled
  savingId.value = server.id
  try {
    await saveMcpServerPreference(server.id, enabled)
    ElMessage.success(enabled ? `已启用 ${server.name}` : `已停用 ${server.name}`)
  } catch {
    // 失败回滚
    server.userEnabled = previous
  } finally {
    savingId.value = null
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

function parseArgs(argsJson: string | null | undefined): string[] {
  if (!argsJson) return []
  try {
    const arr = JSON.parse(argsJson)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
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
  clearFormValidate()
  formVisible.value = true
}

function openEdit(server: MyMcpServer) {
  isEdit.value = true
  editingId.value = server.id
  Object.assign(form, {
    name: server.name,
    description: server.description || '',
    serverType: server.serverType,
    // 回填原连接配置，避免编辑名称/描述时误清空
    command: server.command || '',
    args: parseArgs(server.argsJson),
    url: server.url || '',
    envList: []
  })
  // 编辑时环境变量不回传明文（安全策略），用户可重新填写；为空则保持原值
  clearFormValidate()
  formVisible.value = true
}

/** 弹窗无 destroy-on-close，打开前清掉上一次残留的校验错误状态 */
function clearFormValidate() {
  nextTick(() => formRef.value?.clearValidate())
}

/** 弹窗关闭后兜底清理校验状态（点遮罩/X 关闭不走 openCreate/openEdit） */
function onFormDialogClosed() {
  formRef.value?.clearValidate()
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
      await updateMyMcpServer(editingId.value, payload)
      ElMessage.success('服务器更新成功')
    } else {
      await createMyMcpServer(payload)
      ElMessage.success('服务器创建成功，已自动注入你的会话')
    }
    formVisible.value = false
    await load()
  } catch {
    // 保存成功但列表刷新失败：拦截器已 toast，避免 handleSubmit 整体 reject
  } finally {
    submitting.value = false
  }
}

async function handleDelete(server: MyMcpServer) {
  try {
    await deleteMyMcpServer(server.id)
    ElMessage.success(`已删除 ${server.name}`)
    await load()
  } catch {
    // 错误提示由拦截器统一处理
  }
}

async function handleTest(server: MyMcpServer) {
  currentServer.value = {
    id: server.id,
    userId: 0,
    name: server.name,
    description: server.description,
    serverType: server.serverType,
    command: server.command,
    argsJson: server.argsJson,
    url: server.url,
    status: server.status
  }
  testVisible.value = true
  testError.value = ''
  testTools.value = []
  testing.value = true
  testingId.value = server.id
  try {
    testTools.value = (await testMyMcpServer(server.id)) || []
  } catch (e: any) {
    testError.value = e?.message || '连接失败'
  } finally {
    testingId.value = null
    testing.value = false
  }
}
</script>

<style scoped>
.mcp-servers-page {
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.page-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.page-desc {
  margin: 0;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 13px;
  line-height: 1.6;
}

.section-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.empty-state {
  padding: 32px 0;
  text-align: center;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 14px;
}

.server-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.server-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--aw-divider-soft, #e6e6e6);
  border-radius: 8px;
  background: var(--aw-surface, #fff);
}

.server-info {
  min-width: 0;
}

.server-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.server-name {
  font-weight: 600;
  font-size: 14px;
}

.server-desc {
  color: var(--aw-ink-muted, #8b949e);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.server-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.page-hint {
  margin: 0;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 12px;
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
  color: var(--aw-ink-muted, #8b949e);
  font-size: 12px;
}

:deep(.mcp-server-dialog) {
  --el-dialog-title-font-size: 16px;
  --el-font-size-base: 13px;
}

:deep(.mcp-server-dialog .el-dialog__header) {
  padding-bottom: 12px;
}

:deep(.mcp-server-dialog .el-form-item__label),
:deep(.mcp-server-dialog .el-radio),
:deep(.mcp-server-dialog .el-input__inner),
:deep(.mcp-server-dialog .el-textarea__inner),
:deep(.mcp-server-dialog .el-button) {
  font-size: 13px;
}

:deep(.mcp-server-dialog .el-input__wrapper) {
  font-size: 13px;
}

:deep(.mcp-server-dialog .el-dialog__footer .el-button) {
  font-size: 14px;
}

.test-content {
  min-height: 60px;
}
</style>
