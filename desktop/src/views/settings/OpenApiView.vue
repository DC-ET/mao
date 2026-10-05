<template>
  <div class="open-api-page">
    <div class="page-header">
      <h1 class="page-title">开放接口</h1>
      <p class="page-desc">
        以机器身份触发 Agent：API Token 用于 REST 调用，Webhook 触发器供外部系统推送事件，出站订阅把任务结果回调给你的系统。
      </p>
    </div>

    <!-- ── API Token ─────────────────────────────────────────────── -->
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">API Token</h2>
          <p class="card-desc">以个人身份调用 POST /api/v1/open/agents/:agentId/run 异步触发 Agent；泄露请立即吊销。</p>
        </div>
        <button class="create-btn" @click="openTokenDialog">
          <el-icon><Plus /></el-icon> 签发 Token
        </button>
      </div>
      <div v-if="tokensLoading" class="empty-state">加载中...</div>
      <div v-else-if="tokens.length === 0" class="empty-state">暂无 API Token</div>
      <div v-else class="item-list">
        <div v-for="token in tokens" :key="token.id" class="item-card">
          <div class="item-row">
            <div class="item-title">
              {{ token.name }}
              <span v-if="token.revokedAt" class="badge badge-danger">已吊销</span>
              <span v-else-if="isExpired(token.expiresAt)" class="badge badge-danger">已过期</span>
            </div>
            <div class="item-actions">
              <button
                v-if="!token.revokedAt"
                class="action-btn action-btn-danger"
                :title="confirmingRevokeId === token.id ? '确认吊销' : '吊销'"
                @click="confirmRevoke(token)"
              >
                <el-icon :size="14"><Delete /></el-icon>
              </button>
            </div>
          </div>
          <div class="item-meta">
            <span class="mono">{{ token.tokenPrefix }}…</span>
            <span>scope：{{ token.scopes.join('、') }}</span>
            <span>过期：{{ token.expiresAt ? formatTime(token.expiresAt) : '永不过期' }}</span>
            <span>最后使用：{{ token.lastUsedAt ? formatTime(token.lastUsedAt) : '从未使用' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Webhook 触发器 ────────────────────────────────────────── -->
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Webhook 触发器</h2>
          <p class="card-desc">外部系统向触发器 URL POST 事件即触发 Agent；HMAC-SHA256 验签，连续失败 5 次自动停用。</p>
        </div>
        <button class="create-btn" @click="openTriggerDialog">
          <el-icon><Plus /></el-icon> 新建触发器
        </button>
      </div>
      <div v-if="triggersLoading" class="empty-state">加载中...</div>
      <div v-else-if="triggers.length === 0" class="empty-state">暂无 Webhook 触发器</div>
      <div v-else class="item-list">
        <div v-for="trigger in triggers" :key="trigger.id" class="item-card">
          <div class="item-row">
            <div class="item-title">
              {{ trigger.name }}
              <span v-if="trigger.enabled" class="badge badge-ok">启用中</span>
              <span v-else class="badge badge-danger">已停用</span>
              <span v-if="trigger.consecutiveFailures > 0" class="badge badge-warn">连续失败 {{ trigger.consecutiveFailures }}</span>
            </div>
            <div class="item-actions">
              <el-tooltip content="轮换 Secret" :show-after="300">
                <button class="action-btn" @click="rotateTrigger(trigger)"><el-icon :size="14"><RefreshRight /></el-icon></button>
              </el-tooltip>
              <el-tooltip :content="trigger.enabled ? '停用' : '启用'" :show-after="300">
                <button class="action-btn" @click="toggleTrigger(trigger)">
                  <el-icon :size="14"><component :is="trigger.enabled ? VideoPause : VideoPlay" /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="删除" :show-after="300">
                <button class="action-btn action-btn-danger" @click="removeTrigger(trigger)"><el-icon :size="14"><Delete /></el-icon></button>
              </el-tooltip>
            </div>
          </div>
          <div class="item-meta">
            <span class="mono url-text" :title="trigger.url ?? ''">{{ trigger.url }}</span>
            <span>绑定会话：{{ trigger.sessionId != null ? `#${trigger.sessionId}` : '每次新建会话' }}</span>
            <span>最近触发：{{ trigger.lastFiredAt ? formatTime(trigger.lastFiredAt) : '从未触发' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 出站订阅 ──────────────────────────────────────────────── -->
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">出站订阅</h2>
          <p class="card-desc">任务完成/失败或 Agent 提问时，向你的系统回调带 HMAC 签名的事件；失败自动退避重试 3 次。</p>
        </div>
        <button class="create-btn" @click="openSubscriptionDialog">
          <el-icon><Plus /></el-icon> 新建订阅
        </button>
      </div>
      <div v-if="subscriptionsLoading" class="empty-state">加载中...</div>
      <div v-else-if="subscriptions.length === 0" class="empty-state">暂无出站订阅</div>
      <div v-else class="item-list">
        <div v-for="sub in subscriptions" :key="sub.id" class="item-card">
          <div class="item-row">
            <div class="item-title">
              <span class="mono">{{ sub.event }}</span>
              <span v-if="sub.enabled" class="badge badge-ok">接收中</span>
              <span v-else class="badge badge-danger">已停用</span>
            </div>
            <div class="item-actions">
              <el-tooltip content="最近投递" :show-after="300">
                <button class="action-btn" @click="showDeliveries(sub)"><el-icon :size="14"><Clock /></el-icon></button>
              </el-tooltip>
              <el-tooltip :content="sub.enabled ? '停用' : '启用'" :show-after="300">
                <button class="action-btn" @click="toggleSubscription(sub)">
                  <el-icon :size="14"><component :is="sub.enabled ? VideoPause : VideoPlay" /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="删除" :show-after="300">
                <button class="action-btn action-btn-danger" @click="removeSubscription(sub)"><el-icon :size="14"><Delete /></el-icon></button>
              </el-tooltip>
            </div>
          </div>
          <div class="item-meta">
            <span class="mono url-text" :title="sub.targetUrl">{{ sub.targetUrl }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 签发 Token -->
    <el-dialog v-model="tokenDialogVisible" title="签发 API Token" width="440px" class="open-api-dialog" append-to-body @closed="resetTokenForm">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="tokenForm.name" placeholder="如：CI 流水线" maxlength="128" />
        </el-form-item>
        <el-form-item label="权限（scope）">
          <el-checkbox-group v-model="tokenForm.scopes">
            <el-checkbox value="open:run">open:run（触发 Agent 执行）</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="tokenDialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canIssueToken || submitting" @click="submitToken">
          {{ submitting ? '签发中…' : '签发' }}
        </button>
      </template>
    </el-dialog>

    <!-- 新建触发器 -->
    <el-dialog v-model="triggerDialogVisible" title="新建 Webhook 触发器" width="440px" class="open-api-dialog" append-to-body @closed="resetTriggerForm">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="triggerForm.name" placeholder="如：CI 失败分析" maxlength="128" />
        </el-form-item>
        <el-form-item label="Agent">
          <el-select v-model="triggerForm.agentId" placeholder="选择 Agent" filterable style="width: 100%">
            <el-option v-for="agent in agents" :key="agent.id" :label="agent.name" :value="agent.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定会话（可选，默认每次新建会话）">
          <el-select
            v-model="triggerForm.sessionId"
            placeholder="搜索并选择会话"
            clearable
            filterable
            remote
            :remote-method="searchSessionOptions"
            :loading="sessionSearching"
            style="width: 100%"
          >
            <el-option v-for="s in sessionOptions" :key="s.id" :label="s.title" :value="Number(s.id)" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="triggerDialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canCreateTrigger || submitting" @click="submitTrigger">
          {{ submitting ? '创建中…' : '创建' }}
        </button>
      </template>
    </el-dialog>

    <!-- 新建订阅 -->
    <el-dialog v-model="subscriptionDialogVisible" title="新建出站订阅" width="440px" class="open-api-dialog" append-to-body @closed="resetSubscriptionForm">
      <el-form label-position="top">
        <el-form-item label="事件">
          <el-select v-model="subscriptionForm.event" style="width: 100%">
            <el-option label="任务完成（task.completed）" value="task.completed" />
            <el-option label="任务失败（task.failed）" value="task.failed" />
            <el-option label="提问待答（question.pending）" value="question.pending" />
          </el-select>
        </el-form-item>
        <el-form-item label="回调地址（仅支持 https）">
          <el-input v-model="subscriptionForm.targetUrl" placeholder="https://your-system.example.com/hooks/mao" />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="subscriptionDialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canCreateSubscription || submitting" @click="submitSubscription">
          {{ submitting ? '创建中…' : '创建' }}
        </button>
      </template>
    </el-dialog>

    <!-- Secret 一次性展示 -->
    <el-dialog v-model="secretDialogVisible" :title="secretDialogTitle" width="520px" class="open-api-dialog" append-to-body>
      <p class="secret-warn">{{ secretDialogWarning }}</p>
      <div v-if="secretDialogUrl" class="secret-field">
        <div class="secret-label">触发器 URL</div>
        <el-input :model-value="secretDialogUrl" readonly>
          <template #append>
            <el-button @click="copyText(secretDialogUrl)"><el-icon><CopyDocument /></el-icon></el-button>
          </template>
        </el-input>
      </div>
      <div class="secret-field">
        <div class="secret-label">Secret</div>
        <el-input :model-value="secretDialogSecret" readonly>
          <template #append>
            <el-button @click="copyText(secretDialogSecret)"><el-icon><CopyDocument /></el-icon></el-button>
          </template>
        </el-input>
      </div>
      <div v-if="secretDialogToken" class="secret-field">
        <div class="secret-label">API Token（明文仅此一次）</div>
        <el-input :model-value="secretDialogToken" readonly>
          <template #append>
            <el-button @click="copyText(secretDialogToken)"><el-icon><CopyDocument /></el-icon></el-button>
          </template>
        </el-input>
      </div>
      <template #footer>
        <button class="dialog-btn dialog-btn-confirm" @click="secretDialogVisible = false">我已保存</button>
      </template>
    </el-dialog>

    <!-- 最近投递 -->
    <el-dialog v-model="deliveriesDialogVisible" title="最近投递记录" width="560px" class="open-api-dialog" append-to-body>
      <div v-if="deliveriesLoading" class="empty-state">加载中...</div>
      <div v-else-if="deliveries.length === 0" class="empty-state">暂无投递记录</div>
      <div v-else class="item-list">
        <div v-for="d in deliveries" :key="d.id" class="item-card">
          <div class="item-row">
            <div class="item-title">
              <span class="badge" :class="d.status === 'SUCCEEDED' ? 'badge-ok' : d.status === 'PENDING' || d.status === 'SENDING' ? 'badge-warn' : 'badge-danger'">{{ d.status }}</span>
              <span class="mono">{{ d.event }}</span>
            </div>
            <div class="item-meta">
              <span>第 {{ d.attemptCount }} 次尝试</span>
              <span v-if="d.lastHttpStatus != null">HTTP {{ d.lastHttpStatus }}</span>
              <span v-if="d.lastError">{{ d.lastError }}</span>
              <span>{{ d.createdAt ? formatTime(d.createdAt) : '' }}</span>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Delete, RefreshRight, VideoPause, VideoPlay, Clock, CopyDocument } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  api, searchSessions,
  listApiTokens, issueApiToken, revokeApiToken,
  listWebhookTriggers, createWebhookTrigger, updateWebhookTrigger, deleteWebhookTrigger, rotateWebhookTriggerSecret,
  listOutboundSubscriptions, createOutboundSubscription, setOutboundSubscriptionEnabled, deleteOutboundSubscription,
  listOutboundDeliveries,
  type ApiTokenView, type WebhookTriggerView, type OutboundSubscriptionView, type OutboundDeliveryView
} from '../../api'

interface AgentOption { id: number; name: string | null }
interface SessionOption { id: string; title: string | null }

const tokens = ref<ApiTokenView[]>([])
const triggers = ref<WebhookTriggerView[]>([])
const subscriptions = ref<OutboundSubscriptionView[]>([])
const agents = ref<AgentOption[]>([])
const sessionOptions = ref<SessionOption[]>([])

const tokensLoading = ref(false)
const triggersLoading = ref(false)
const subscriptionsLoading = ref(false)
const sessionSearching = ref(false)
const submitting = ref(false)

const tokenDialogVisible = ref(false)
const triggerDialogVisible = ref(false)
const subscriptionDialogVisible = ref(false)
const secretDialogVisible = ref(false)
const deliveriesDialogVisible = ref(false)
const deliveriesLoading = ref(false)
const deliveries = ref<OutboundDeliveryView[]>([])

const tokenForm = ref({ name: '', scopes: ['open:run'] as string[] })
const triggerForm = ref<{ name: string; agentId: number | null; sessionId: number | null }>({ name: '', agentId: null, sessionId: null })
const subscriptionForm = ref({ event: 'task.completed', targetUrl: '' })

const secretDialogTitle = ref('')
const secretDialogWarning = ref('')
const secretDialogUrl = ref('')
const secretDialogSecret = ref('')
const secretDialogToken = ref('')

const confirmingRevokeId = ref<number | null>(null)

const canIssueToken = computed(() => tokenForm.value.name.trim().length > 0 && tokenForm.value.scopes.length > 0)
const canCreateTrigger = computed(() => triggerForm.value.name.trim().length > 0 && triggerForm.value.agentId != null)
const canCreateSubscription = computed(() => subscriptionForm.value.targetUrl.trim().startsWith('https://'))

function formatTime(value: string | null): string {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt.replace(' ', 'T')).getTime() < Date.now()
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择复制')
  }
}

async function fetchAgents(): Promise<void> {
  try {
    const { data } = await api.get('/agents')
    agents.value = ((data || []) as AgentOption[]).filter((agent) => agent.enabled !== false && agent.enabled !== 0)
  } catch {
    agents.value = []
  }
}

async function searchSessionOptions(keyword: string): Promise<void> {
  sessionSearching.value = true
  try {
    sessionOptions.value = await searchSessions(keyword)
  } catch {
    sessionOptions.value = []
  } finally {
    sessionSearching.value = false
  }
}

async function fetchTokens(): Promise<void> {
  tokensLoading.value = true
  try {
    tokens.value = await listApiTokens()
  } finally {
    tokensLoading.value = false
  }
}

async function fetchTriggers(): Promise<void> {
  triggersLoading.value = true
  try {
    triggers.value = await listWebhookTriggers()
  } finally {
    triggersLoading.value = false
  }
}

async function fetchSubscriptions(): Promise<void> {
  subscriptionsLoading.value = true
  try {
    subscriptions.value = await listOutboundSubscriptions()
  } finally {
    subscriptionsLoading.value = false
  }
}

// ── Token ──
function openTokenDialog(): void {
  tokenForm.value = { name: '', scopes: ['open:run'] }
  tokenDialogVisible.value = true
}

function resetTokenForm(): void {
  tokenForm.value = { name: '', scopes: ['open:run'] }
}

async function submitToken(): Promise<void> {
  if (!canIssueToken.value || submitting.value) return
  submitting.value = true
  try {
    const issued = await issueApiToken({ name: tokenForm.value.name.trim(), scopes: tokenForm.value.scopes })
    tokenDialogVisible.value = false
    secretDialogTitle.value = 'Token 已签发'
    secretDialogWarning.value = '请立即保存以下明文 Token，关闭后无法再次查看；泄露请立即吊销。'
    secretDialogUrl.value = ''
    secretDialogSecret.value = ''
    secretDialogToken.value = issued.plainToken
    secretDialogVisible.value = true
    await fetchTokens()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function confirmRevoke(token: ApiTokenView): Promise<void> {
  if (confirmingRevokeId.value !== token.id) {
    confirmingRevokeId.value = token.id
    setTimeout(() => {
      if (confirmingRevokeId.value === token.id) confirmingRevokeId.value = null
    }, 3000)
    return
  }
  confirmingRevokeId.value = null
  try {
    await revokeApiToken(token.id)
    ElMessage.success('Token 已吊销')
    await fetchTokens()
  } catch {
    // handled by interceptor
  }
}

// ── 触发器 ──
function openTriggerDialog(): void {
  triggerForm.value = { name: '', agentId: null, sessionId: null }
  sessionOptions.value = []
  if (agents.value.length === 0) void fetchAgents()
  triggerDialogVisible.value = true
}

function resetTriggerForm(): void {
  triggerForm.value = { name: '', agentId: null, sessionId: null }
}

async function submitTrigger(): Promise<void> {
  if (!canCreateTrigger.value || submitting.value) return
  submitting.value = true
  try {
    const created = await createWebhookTrigger({
      name: triggerForm.value.name.trim(),
      agentId: triggerForm.value.agentId!,
      sessionId: triggerForm.value.sessionId ?? null
    })
    triggerDialogVisible.value = false
    secretDialogTitle.value = '触发器已创建'
    secretDialogWarning.value = '请立即保存以下 Secret，关闭后无法再次查看；可通过「轮换 Secret」重置。'
    secretDialogUrl.value = created.url
    secretDialogSecret.value = created.plainSecret
    secretDialogToken.value = ''
    secretDialogVisible.value = true
    await fetchTriggers()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function toggleTrigger(trigger: WebhookTriggerView): Promise<void> {
  try {
    await updateWebhookTrigger(trigger.id, { enabled: !trigger.enabled })
    await fetchTriggers()
  } catch {
    // handled by interceptor
  }
}

async function rotateTrigger(trigger: WebhookTriggerView): Promise<void> {
  try {
    const rotated = await rotateWebhookTriggerSecret(trigger.id)
    secretDialogTitle.value = 'Secret 已轮换'
    secretDialogWarning.value = '旧 Secret 已立即失效，请将新 Secret 更新到外部系统。'
    secretDialogUrl.value = trigger.url ?? ''
    secretDialogSecret.value = rotated.plainSecret
    secretDialogToken.value = ''
    secretDialogVisible.value = true
  } catch {
    // handled by interceptor
  }
}

async function removeTrigger(trigger: WebhookTriggerView): Promise<void> {
  try {
    await deleteWebhookTrigger(trigger.id)
    ElMessage.success('触发器已删除')
    await fetchTriggers()
  } catch {
    // handled by interceptor
  }
}

// ── 订阅 ──
function openSubscriptionDialog(): void {
  subscriptionForm.value = { event: 'task.completed', targetUrl: '' }
  subscriptionDialogVisible.value = true
}

function resetSubscriptionForm(): void {
  subscriptionForm.value = { event: 'task.completed', targetUrl: '' }
}

async function submitSubscription(): Promise<void> {
  if (!canCreateSubscription.value || submitting.value) return
  submitting.value = true
  try {
    const created = await createOutboundSubscription({
      event: subscriptionForm.value.event,
      targetUrl: subscriptionForm.value.targetUrl.trim()
    })
    subscriptionDialogVisible.value = false
    secretDialogTitle.value = '订阅已创建'
    secretDialogWarning.value = '请立即保存以下 Secret，用于校验回调的 X-Mao-Signature 签名头。'
    secretDialogUrl.value = ''
    secretDialogSecret.value = created.plainSecret
    secretDialogToken.value = ''
    secretDialogVisible.value = true
    await fetchSubscriptions()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function toggleSubscription(sub: OutboundSubscriptionView): Promise<void> {
  try {
    await setOutboundSubscriptionEnabled(sub.id, !sub.enabled)
    await fetchSubscriptions()
  } catch {
    // handled by interceptor
  }
}

async function removeSubscription(sub: OutboundSubscriptionView): Promise<void> {
  try {
    await deleteOutboundSubscription(sub.id)
    ElMessage.success('订阅已删除')
    await fetchSubscriptions()
  } catch {
    // handled by interceptor
  }
}

async function showDeliveries(sub: OutboundSubscriptionView): Promise<void> {
  deliveriesDialogVisible.value = true
  deliveriesLoading.value = true
  try {
    deliveries.value = await listOutboundDeliveries(sub.id)
  } catch {
    deliveries.value = []
  } finally {
    deliveriesLoading.value = false
  }
}

onMounted(() => {
  void fetchTokens()
  void fetchTriggers()
  void fetchSubscriptions()
})
</script>

<style scoped>
.open-api-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  margin-bottom: 4px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 8px;
}

.page-desc {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
  max-width: 560px;
}

.card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 14px 16px;
  max-width: 760px;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 4px;
}

.card-desc {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
  max-width: 520px;
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.create-btn:hover {
  opacity: 0.85;
}

.empty-state {
  text-align: center;
  padding: 28px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item-card {
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  padding: 10px 12px;
}

.item-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.item-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
  flex-wrap: wrap;
}

.item-actions {
  display: flex;
  gap: 2px;
}

.item-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.item-meta .mono,
.item-title .mono {
  font-family: var(--aw-font-mono, monospace);
}

.url-text {
  word-break: break-all;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted);
}

.action-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.badge-ok {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}

.badge-warn {
  background: rgba(245, 158, 11, 0.14);
  color: #d97706;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.secret-warn {
  font-size: 12px;
  color: #d97706;
  margin: 0 0 12px;
}

.secret-field {
  margin-bottom: 12px;
}

.secret-label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 4px;
}
</style>

<style>
.open-api-dialog {
  --el-font-size-base: 13px;
  --el-font-size-small: 12px;
}

.open-api-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}
</style>
