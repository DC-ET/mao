<template>
  <el-dialog
    :model-value="modelValue"
    title="分享会话"
    width="480px"
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <p class="share-hint">
      {{ share?.expiresAt
        ? '匿名链接无需登录，任何持有者在到期前可读。'
        : '任何登录用户持链接可读。' }}
      源会话撤回或删除消息后，分享内容同步消失；编辑重发会以新内容呈现，并隐藏其后的消息。之后新增的消息不会出现，除非刷新快照。
    </p>
    <div v-if="loading" class="share-loading">加载中…</div>
    <template v-else-if="share">
      <div class="share-link-row">
        <input class="share-link" readonly :value="link" />
        <button type="button" class="share-btn" @click="copy">复制</button>
      </div>
      <p class="share-meta">访问 {{ share.viewCount }} 次<span v-if="share.expiresAt"> · 到期 {{ share.expiresAt }}</span></p>
      <div class="share-actions">
        <button type="button" class="share-btn" :disabled="busy" @click="refresh">刷新快照</button>
        <button type="button" class="share-btn danger" :disabled="busy" @click="revoke">撤销</button>
      </div>
    </template>
    <template v-else>
      <label class="share-public">
        <input v-model="publicLink" type="checkbox" />
        匿名链接（带过期，需管理员开启，默认关闭）
      </label>
      <label v-if="publicLink" class="share-days">
        有效天数
        <input v-model.number="expiresInDays" type="number" min="1" max="365" />
      </label>
      <button type="button" class="share-btn primary" :disabled="busy" @click="create">生成链接</button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createSessionShare,
  getSessionShare,
  refreshSessionShare,
  revokeSessionShare,
  type SessionShareInfo,
} from '../../api'
import { sharePageUrl } from '../../utils/sessionShare'

const props = defineProps<{
  modelValue: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const loading = ref(false)
const busy = ref(false)
const share = ref<SessionShareInfo | null>(null)
const publicLink = ref(false)
const expiresInDays = ref(7)

const link = computed(() => share.value ? sharePageUrl(share.value.token, !!share.value.expiresAt) : '')

async function load() {
  if (!props.sessionId) return
  loading.value = true
  // 宿主（TaskIndexPanel / SideTaskList）常驻同一实例，靠 sessionId 切换复用；
  // 表单状态必须在打开时复位，否则上一个会话的勾选与天数会静默带到下一个会话
  publicLink.value = false
  expiresInDays.value = 7
  try {
    share.value = await getSessionShare(props.sessionId)
  } catch {
    share.value = null
  } finally {
    loading.value = false
  }
}

async function create() {
  busy.value = true
  try {
    share.value = await createSessionShare(props.sessionId, publicLink.value
      ? { publicLink: true, expiresInDays: expiresInDays.value }
      : {})
  } catch (e) {
    // 拦截器只对带信封的失败提示；匿名链接开关关闭（400）同样是信封错误，
    // 但网络层 / 超时不会有信封，此时补一条提示，避免"点了没反应"
    const withToast = e as { toastShown?: boolean }
    if (!withToast?.toastShown) ElMessage.error('生成分享链接失败，请稍后重试')
  } finally {
    busy.value = false
  }
}

async function refresh() {
  busy.value = true
  try {
    share.value = await refreshSessionShare(props.sessionId)
    ElMessage.success('已刷新快照')
  } catch {
    // 拦截器已提示
  } finally {
    busy.value = false
  }
}

async function revoke() {
  try {
    await ElMessageBox.confirm('撤销后原链接立即失效，确定撤销？', '撤销分享', { type: 'warning' })
  } catch {
    return
  }
  busy.value = true
  try {
    await revokeSessionShare(props.sessionId)
    share.value = null
    ElMessage.success('已撤销')
  } catch {
    // 拦截器已提示
  } finally {
    busy.value = false
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    ElMessage.success('已复制链接')
  } catch {
    ElMessage.error('复制失败')
  }
}
</script>

<style>
.share-hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--aw-ink-muted, #86868b);
}
.share-link-row {
  display: flex;
  gap: 8px;
}
.share-link {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--aw-hairline, #e0e0e0);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--aw-canvas, #fff);
  color: var(--aw-ink, #1d1d1f);
}
.share-meta {
  margin: 8px 0;
  font-size: 12px;
  color: var(--aw-ink-muted, #86868b);
}
.share-actions {
  display: flex;
  gap: 8px;
}
.share-btn {
  border: 1px solid var(--aw-hairline, #e0e0e0);
  background: var(--aw-canvas, #fff);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--aw-ink, #1d1d1f);
}
.share-btn.primary {
  background: var(--aw-primary, #0066cc);
  color: #fff;
  border-color: transparent;
}
.share-btn.danger {
  color: var(--aw-danger, #ff3b30);
}
.share-public, .share-days {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
.share-days input {
  width: 72px;
}
</style>
