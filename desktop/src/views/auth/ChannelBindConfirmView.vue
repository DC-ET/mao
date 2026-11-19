<template>
  <div class="channel-bind-confirm">
    <div v-if="phase === 'loading'" class="hint">正在加载绑定信息…</div>

    <div v-else-if="phase === 'preview'" class="card">
      <h2 class="title">{{ channelLabel }}账号绑定</h2>
      <p class="desc">请核对以下双方身份，确认无误后点击「确认绑定」。</p>

      <div class="identity">
        <div class="identity-row">
          <span class="identity-label">{{ channelLabel }}用户</span>
          <span class="identity-value">{{ senderDisplay }}</span>
        </div>
        <div class="identity-arrow">↓</div>
        <div class="identity-row">
          <span class="identity-label">Mao 账号</span>
          <span class="identity-value">{{ currentUsername || '当前登录账号' }}</span>
        </div>
      </div>

      <div v-if="chatTypeText" class="meta-line">会话类型：{{ chatTypeText }}</div>
      <div v-if="expiresAtText" class="meta-line">链接有效期至：{{ expiresAtText }}</div>
      <div v-if="preview?.willRebind" class="warn-line">当前账号已绑定其它{{ channelLabel }}身份，确认后将替换现有绑定。</div>

      <div class="actions">
        <el-button type="primary" :loading="binding" @click="confirmBind">确认绑定</el-button>
        <el-button :disabled="binding" @click="cancel">取消</el-button>
      </div>
    </div>

    <div v-else-if="phase === 'cancelled'" class="card">
      <h2 class="title">已取消绑定</h2>
      <p class="desc">未发生任何绑定，可返回 IM 重新发起。</p>
    </div>

    <div v-else-if="phase === 'binding'" class="card">
      <h2 class="title">正在绑定…</h2>
      <p class="desc">正在确认绑定并恢复你刚才的消息，请稍候。</p>
    </div>

    <div v-else class="card">
      <h2 class="title">{{ resultTitle }}</h2>
      <p class="desc">{{ result?.message || '绑定流程结束' }}</p>
      <p class="hint">请回到{{ channelLabel }}查看会话处理结果。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api'

interface ChannelBindPreview {
  senderName: string | null
  chatType: string | null
  expiresAt: string | null
  currentUser: { id: number; username: string | null } | null
  willRebind: boolean
}

interface ChannelBindResult {
  status: 'success' | 'partial' | 'failed'
  message: string
  senderName: string | null
}

const route = useRoute()

const channel = computed(() => (route.meta.channel === 'dingtalk' ? 'dingtalk' : 'feishu'))
const channelLabel = computed(() => (channel.value === 'dingtalk' ? '钉钉' : '飞书'))
const state = computed(() => String(route.params.state ?? ''))

type Phase = 'loading' | 'preview' | 'binding' | 'done' | 'cancelled'
const phase = ref<Phase>('loading')
const preview = ref<ChannelBindPreview | null>(null)
const result = ref<ChannelBindResult | null>(null)
const failMessage = ref('')
const binding = ref(false)

const senderDisplay = computed(() => {
  const name = preview.value?.senderName?.trim() ?? ''
  // 飞书事件可能没有可解析的姓名：兜底显示通道用户，不渲染空
  return name !== '' ? name : `${channelLabel.value}用户`
})
const currentUsername = computed(() => preview.value?.currentUser?.username ?? '')
const chatTypeText = computed(() => {
  const type = preview.value?.chatType ?? ''
  if (type === 'group') return '群聊'
  if (type === 'p2p') return '单聊'
  return type === '' ? '' : type
})
const expiresAtText = computed(() => {
  const raw = preview.value?.expiresAt ?? ''
  if (raw === '') return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString()
})
const resultTitle = computed(() => {
  if (result.value == null) return failMessage.value !== '' ? '绑定未完成' : '绑定未完成'
  if (result.value.status === 'success') return '绑定成功'
  if (result.value.status === 'partial') return '绑定未完全成功'
  return '绑定未完成'
})

function extractErrorMessage(err: unknown, fallback: string): string {
  // HTTP 级错误：err.response.data.message；业务失败（HTTP 200 + code≠0）：拦截器转成的裸 Error.message
  const resp = (err as { response?: { data?: { message?: unknown } } } | undefined)?.response
  const respMessage = resp?.data?.message
  if (typeof respMessage === 'string' && respMessage !== '') return respMessage
  const direct = (err as { message?: unknown } | undefined)?.message
  if (typeof direct === 'string' && direct !== '') return direct
  return fallback
}

async function loadPreview(): Promise<void> {
  phase.value = 'loading'
  try {
    const { data } = await api.get(`/${channel.value}/binding/pending`, { params: { state: state.value } })
    preview.value = (data?.data ?? null) as ChannelBindPreview | null
    if (preview.value == null) {
      failMessage.value = '未找到绑定信息'
      result.value = { status: 'failed', message: failMessage.value, senderName: null }
      phase.value = 'done'
      return
    }
    phase.value = 'preview'
  } catch (err) {
    // 业务失败提示由响应拦截器统一弹出，这里只渲染失败结果，不再重复 toast
    failMessage.value = extractErrorMessage(err, '链接已过期或已使用，请回 IM 重新发送一条消息')
    result.value = { status: 'failed', message: failMessage.value, senderName: null }
    phase.value = 'done'
  }
}

async function confirmBind(): Promise<void> {
  if (binding.value) return
  binding.value = true
  phase.value = 'binding'
  try {
    const { data } = await api.post(`/${channel.value}/binding/complete`, { state: state.value })
    result.value = (data?.data ?? { status: 'failed', message: '绑定失败', senderName: null }) as ChannelBindResult
  } catch (err) {
    result.value = { status: 'failed', message: extractErrorMessage(err, '绑定失败，请稍后重试'), senderName: null }
  } finally {
    binding.value = false
    phase.value = 'done'
  }
}

function cancel(): void {
  // 不调任何接口：state 不消费，TTL 内可重新进入确认页
  phase.value = 'cancelled'
}

onMounted(loadPreview)
</script>

<style scoped>
.channel-bind-confirm {
  display: flex;
  justify-content: center;
  padding: 48px 16px;
}
.card {
  width: 420px;
  max-width: 100%;
  padding: 28px 28px 24px;
  border-radius: 12px;
  background: var(--aw-bg-panel, #fff);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
}
.title { margin: 0 0 8px; font-size: 20px; }
.desc { margin: 0 0 16px; color: var(--aw-ink, #333); }
.hint { color: var(--aw-ink-muted, #888); }
.identity {
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--aw-bg-subtle, #f7f8fa);
  margin-bottom: 14px;
}
.identity-row { display: flex; justify-content: space-between; align-items: center; }
.identity-label { color: var(--aw-ink-muted, #888); }
.identity-value { font-weight: 600; }
.identity-arrow { text-align: center; color: var(--aw-ink-muted, #888); margin: 4px 0; }
.meta-line { color: var(--aw-ink-muted, #888); font-size: 13px; margin-bottom: 4px; }
.warn-line { color: #b45309; font-size: 13px; margin: 10px 0 0; }
.actions { margin-top: 20px; display: flex; gap: 8px; }
</style>
