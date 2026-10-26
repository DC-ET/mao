<template>
  <el-dialog
    v-model="visible"
    title="编辑定时任务"
    width="min(520px, calc(100vw - 32px))"
    class="scheduled-task-edit-dialog management-dialog"
    append-to-body
  >
    <el-alert
      v-if="finished"
      type="warning"
      :closable="false"
      show-icon
      title="该任务已完结"
      description="保存后若 Cron 能算出下次触发时间，任务会自动重新激活（恢复为进行中）。"
      class="finished-alert"
    />

    <el-form :model="form" label-position="top">
      <el-form-item label="任务名称" required>
        <el-input v-model="form.name" maxlength="200" show-word-limit placeholder="任务名称" />
      </el-form-item>

      <el-form-item label="Cron 表达式" required>
        <el-input
          v-model="form.cronExpression"
          placeholder="秒 分 时 日 月 周，如 0 0 9 * * ?"
          @input="onCronInput"
        />
        <div class="form-hint">
          6 位 Spring 表达式：每天早上 9 点 <code>0 0 9 * * ?</code>；每 30 分钟 <code>0 */30 * * * ?</code>；每周一 10 点
          <code>0 0 10 * * MON</code>；固定「月 + 日」算一次性，如 8 月 15 日 8 点 <code>0 0 8 15 8 ?</code>。
        </div>
      </el-form-item>

      <el-form-item label="下次触发">
        <div v-if="previewLoading" class="preview-loading">校验中…</div>
        <template v-else-if="preview && preview.valid">
          <div class="preview-times">
            <span v-for="(time, index) in preview.nextFireTimes" :key="time" class="preview-time">
              {{ index + 1 }}. {{ time }}
            </span>
            <span class="preview-tz">（北京时间）</span>
            <el-tag v-if="preview.oneShot" type="warning" size="small">一次性任务</el-tag>
          </div>
        </template>
        <div v-else class="preview-error">{{ preview?.message || localCronError || '请输入 Cron 表达式' }}</div>
      </el-form-item>

      <el-form-item label="一次性任务">
        <el-switch v-model="form.once" @change="onceTouched = true" />
        <span class="switch-hint">
          {{ form.once ? '触发一次后自动完结' : '按 Cron 长期循环触发' }}
        </span>
        <div v-if="onceMismatch" class="form-warn">{{ onceMismatch }}</div>
      </el-form-item>

      <button type="button" class="advanced-toggle" @click="advancedOpen = !advancedOpen">
        {{ advancedOpen ? '收起高级设置' : '高级设置（重试 / 间隔 / 错过补偿）' }}
      </button>

      <template v-if="advancedOpen">
        <el-form-item label="失败重试">
          <el-input-number v-model="form.retryMax" :min="0" :max="MAX_RETRY_MAX" :step="1" />
          <span class="switch-hint">次（不含首次，0 表示不重试）</span>
        </el-form-item>
        <el-form-item label="重试间隔">
          <el-input-number v-model="form.retryIntervalMinutes" :min="MIN_RETRY_INTERVAL_MINUTES" :max="MAX_RETRY_INTERVAL_MINUTES" :step="1" />
          <span class="switch-hint">分钟，固定间隔</span>
        </el-form-item>
        <el-form-item label="错过补偿">
          <el-radio-group v-model="form.missedPolicy">
            <el-radio value="RUN_ONCE">补最近一次</el-radio>
            <el-radio value="SKIP">只记录不补</el-radio>
          </el-radio-group>
          <div class="form-hint">停机期间错过的触发点都会留下记录。补最近一次是默认行为；只记录不补适合过期报告没有意义的任务。</div>
        </el-form-item>
      </template>

      <el-form-item label="任务提示词" required>
        <el-input
          v-model="form.prompt"
          type="textarea"
          :rows="8"
          maxlength="10000"
          show-word-limit
          placeholder="触发时 Agent 要执行的任务本体，需自包含；执行频率写在 Cron 里，不要在此重复描述"
        />
        <div class="form-hint">
          这是任务本体原文，不要写「每天/每周」等调度措辞，也不要要求创建或修改定时任务。
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <button class="dialog-btn dialog-btn-cancel" @click="visible = false">取消</button>
      <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit" @click="handleSubmit">
        {{ submitting ? '保存中…' : (finished ? '保存并重新激活' : '保存') }}
      </button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useScheduledTasks } from '../composables/useScheduledTasks'
import type { ScheduledTask } from '../composables/useScheduledTasks'
import {
  buildEditForm,
  buildUpdatePayload,
  canSubmitEdit,
  cronLocalError,
  detailResponseApplies,
  onceMismatchWarning,
  resolveOnceAfterPreview,
  DEFAULT_RETRY_INTERVAL_MINUTES,
  DEFAULT_RETRY_MAX,
  MAX_RETRY_INTERVAL_MINUTES,
  MAX_RETRY_MAX,
  MIN_RETRY_INTERVAL_MINUTES,
  type CronPreviewResult,
  type ScheduledTaskEditFields,
} from '../utils/scheduledTaskEdit'

const PREVIEW_DEBOUNCE_MS = 400

const props = defineProps<{
  modelValue: boolean
  task: ScheduledTask | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', updated: ScheduledTask): void
}>()

const { fetchTaskDetail, updateTask, formatNextFire } = useScheduledTasks()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const form = reactive<ScheduledTaskEditFields>({
  name: '',
  cronExpression: '',
  prompt: '',
  once: false,
  retryMax: DEFAULT_RETRY_MAX,
  retryIntervalMinutes: DEFAULT_RETRY_INTERVAL_MINUTES,
  missedPolicy: 'RUN_ONCE',
})

const submitting = ref(false)
const preview = ref<CronPreviewResult | null>(null)
const previewLoading = ref(false)
/** 用户是否在本弹窗里手动拨过「一次性任务」开关：拨过就不再跟随 Cron 形态自动同步 */
const onceTouched = ref(false)
/** 打开弹窗时的 Cron 原文：只有 Cron 真被改过，才让开关跟随 Cron 形态重新判定 */
const initialCron = ref('')
/** 完结态取详情回包（一次性任务可能在列表加载后、弹窗打开前刚跑完），不用行快照。值同后端 TINYINT：0/1 */
const finished = ref(0)
const advancedOpen = ref(false)

let previewTimer: ReturnType<typeof setTimeout> | null = null
/** 预览请求代次：丢弃过期回包（防抖期间连输 / 重开弹窗时的旧响应覆盖新状态） */
let previewSeq = 0

const localCronError = computed(() => cronLocalError(form.cronExpression))

const canSubmit = computed(() =>
  !submitting.value && canSubmitEdit(form, preview.value)
)

const onceMismatch = computed(() => onceMismatchWarning(form, preview.value, initialCron.value))

watch(() => props.modelValue, (open) => {
  if (open) {
    resetForm()
    void refreshDetail()
    void fetchPreview()
  } else {
    cancelPreview()
  }
})

onUnmounted(cancelPreview)

function resetForm() {
  const task = props.task
  if (!task) return
  Object.assign(form, buildEditForm(task))
  initialCron.value = form.cronExpression.trim()
  onceTouched.value = false
  finished.value = task.finished
  advancedOpen.value = false
  preview.value = null
  previewSeq++
}

/**
 * 详情刷新：对话框打开时重拉详情，对抗多写入方竞态（Agent 的 update_scheduled_task
 * 与面板编辑可能改同一任务，行快照可能已过时）。失败不阻断编辑，仅提示数据可能非最新。
 * 回包必须通过身份校验：在途期间用户可能已关闭并打开了另一个任务，迟到的旧详情
 * 会把新任务表单覆盖掉，保存即把旧任务字段写到新任务上（审查轮 1 Bug 2）。
 */
async function refreshDetail() {
  const task = props.task
  if (!task) return
  const requestedId = task.id
  const detail = await fetchTaskDetail(requestedId)
  if (!detailResponseApplies({
    requestedId,
    dialogOpen: props.modelValue,
    currentTaskId: props.task?.id ?? null,
  })) return
  if (detail == null) {
    ElMessage.warning('任务详情获取失败，当前显示的可能不是最新')
    return
  }
  Object.assign(form, buildEditForm(detail))
  initialCron.value = form.cronExpression.trim()
  finished.value = detail.finished
  onceTouched.value = false
  // 表单已按详情重建，作废打开时基于行快照发起的预览，避免旧 Cron 的回包覆盖新状态
  previewSeq++
  void fetchPreview()
}

/** 手动编辑 Cron 才走防抖预览；打开时的程序化赋值直接预览，避免与 watch 抢跑。 */
function onCronInput() {
  cancelPreview()
  if (localCronError.value !== '') {
    preview.value = null
    return
  }
  previewTimer = setTimeout(() => { void fetchPreview() }, PREVIEW_DEBOUNCE_MS)
}

function cancelPreview() {
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
  }
}

async function fetchPreview() {
  const seq = ++previewSeq
  previewLoading.value = true
  try {
    const { data } = await api.post<CronPreviewResult>('/scheduled-tasks/cron-preview', {
      expression: form.cronExpression,
      count: 3,
    })
    if (seq !== previewSeq) return
    preview.value = data
    // Cron 被改过且用户没手动拨过开关时，开关跟随新的 Cron 形态，避免「一次性 Cron + 关闭开关」导致任务重复触发
    const nextOnce = resolveOnceAfterPreview({
      onceTouched: onceTouched.value,
      cronChanged: form.cronExpression.trim() !== initialCron.value,
      previewOneShot: data.oneShot,
    })
    if (data.valid && nextOnce != null) form.once = nextOnce
  } catch {
    if (seq === previewSeq) {
      preview.value = { valid: false, oneShot: false, nextFireTimes: [], message: 'Cron 校验失败，请稍后重试' }
    }
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

async function handleSubmit() {
  const task = props.task
  if (!task || !canSubmit.value) return
  submitting.value = true
  try {
    // updateTask 内部已吞异常并返回 null（拦截器负责 toast）：失败时对话框保持打开、表单不动
    const updated = await updateTask(task.id, buildUpdatePayload(form))
    if (updated == null) return
    ElMessage.success(updated.nextFireTime ? `已保存，下次触发 ${formatNextFire(updated.nextFireTime)}` : '已保存')
    emit('saved', updated)
    visible.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.finished-alert {
  margin-bottom: 12px;
}

.form-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
  margin-top: 4px;
}

.form-hint code {
  font-family: var(--aw-font-mono);
  background: var(--el-fill-color-light);
  padding: 0 4px;
  border-radius: 4px;
}

.preview-loading,
.preview-error {
  font-size: 13px;
}

.preview-error {
  color: var(--aw-danger);
}

.preview-times {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 13px;
  color: var(--aw-ink);
}

.preview-time {
  font-family: var(--aw-font-mono);
}

.preview-tz {
  color: var(--aw-ink-muted);
}

.form-warn {
  font-size: 12px;
  color: var(--aw-warning);
  line-height: 1.6;
  margin-top: 4px;
}

.switch-hint {
  margin-left: 10px;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.advanced-toggle {
  margin: 0 0 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 12px;
  cursor: pointer;
}

.advanced-toggle:hover {
  color: var(--aw-ink);
}

.dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-cancel:hover {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:hover:not(:disabled) {
  opacity: 0.85;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
