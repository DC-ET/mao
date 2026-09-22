<template>
  <ResponsiveDialog
    v-if="task"
    :model-value="modelValue"
    title="编辑定时任务"
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      v-if="task.finished"
      type="warning"
      :closable="false"
      show-icon
      title="该任务已完结"
      description="保存后若 Cron 能算出下次触发时间，任务会自动重新激活（恢复为进行中）。"
      style="margin-bottom: 12px"
    />

    <el-form :model="form" label-width="110px" label-position="right">
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
        <div v-else class="preview-error">{{ preview?.message || cronLocalError || '请输入 Cron 表达式' }}</div>
      </el-form-item>

      <el-form-item label="一次性任务">
        <el-switch v-model="form.once" @change="onceTouched = true" />
        <span class="switch-hint">
          {{ form.once ? '触发一次后自动完结' : '按 Cron 长期循环触发' }}
        </span>
        <div v-if="onceMismatch" class="form-warn">
          当前 Cron 形态{{ preview?.oneShot ? '是' : '不是' }}一次性，与开关不一致：保存后以开关为准
          {{ form.once ? '（执行一次即完结）' : '（会按 Cron 在下一个同日期再次触发）' }}。
        </div>
      </el-form-item>

      <el-form-item label="任务提示词" required>
        <el-input
          v-model="form.prompt"
          type="textarea"
          :rows="10"
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
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">保存</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import type { CronPreviewResult, ScheduledTaskRow } from './types'

const PREVIEW_DEBOUNCE_MS = 400

const props = defineProps<{
  modelValue: boolean
  task: ScheduledTaskRow | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const form = reactive({
  name: '',
  cronExpression: '',
  prompt: '',
  once: false
})

const submitting = ref(false)
const preview = ref<CronPreviewResult | null>(null)
const previewLoading = ref(false)
/** 用户是否在本弹窗里手动拨过「一次性任务」开关：拨过就不再跟随 Cron 形态自动同步 */
const onceTouched = ref(false)
/** 打开弹窗时的 Cron 原文：只有 Cron 真被改过，才让开关跟随 Cron 形态重新判定 */
const initialCron = ref('')

let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0

const cronLocalError = computed(() => {
  const parts = form.cronExpression.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  if (parts.length === 0) return ''
  return parts.length === 6 ? '' : '需为 6 段：秒 分 时 日 月 周'
})

const onceMismatch = computed(() =>
  Boolean(preview.value?.valid) && form.cronExpression.trim() !== initialCron.value && form.once !== preview.value?.oneShot
)

const canSubmit = computed(() =>
  !submitting.value
  && form.name.trim().length > 0
  && form.prompt.trim().length > 0
  && cronLocalError.value === ''
  && preview.value?.valid === true
)

watch(() => props.modelValue, (visible) => {
  if (visible) resetForm()
  else cancelPreview()
})

function resetForm() {
  const task = props.task
  if (!task) return
  form.name = task.name ?? ''
  form.cronExpression = task.cronExpression ?? ''
  form.prompt = task.prompt ?? ''
  form.once = task.once === 1
  initialCron.value = form.cronExpression.trim()
  onceTouched.value = false
  preview.value = null
  previewSeq++
  void fetchPreview()
}

/** 手动编辑 Cron 才走防抖预览；resetForm 里的程序化赋值直接预览，避免与 watch 抢跑。 */
function onCronInput() {
  cancelPreview()
  if (cronLocalError.value !== '') {
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
      count: 3
    })
    if (seq !== previewSeq) return
    preview.value = data
    // Cron 被改过且用户没手动拨过开关时，开关跟随新的 Cron 形态，避免「一次性 Cron + 关闭开关」导致任务每年重复
    if (data.valid && !onceTouched.value && form.cronExpression.trim() !== initialCron.value) {
      form.once = data.oneShot
    }
  } catch {
    if (seq === previewSeq) preview.value = { valid: false, oneShot: false, nextFireTimes: [], message: 'Cron 校验失败，请稍后重试' }
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

async function handleSubmit() {
  const task = props.task
  if (!task) return
  submitting.value = true
  try {
    const { data } = await api.put(`/scheduled-tasks/${task.id}`, {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cronExpression: form.cronExpression.trim(),
      once: form.once
    })
    const next = data?.nextFireTime
    ElMessage.success(next ? `已保存，下次触发 ${next}` : '已保存')
    emit('saved')
    emit('update:modelValue', false)
  } catch {
    // 拦截器已提示（含后端 cron / 名称 / 提示词校验失败文案）
  } finally {
    submitting.value = false
  }
}

onUnmounted(cancelPreview)
</script>

<style scoped>
.form-hint {
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.6;
  margin-top: 4px;
}

.form-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  background: var(--el-fill-color-light);
  padding: 0 4px;
  border-radius: 4px;
}

.preview-loading,
.preview-error {
  font-size: 13px;
}

.preview-error {
  color: var(--mao-danger);
}

.preview-times {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 13px;
  color: var(--mao-ink);
}

.preview-time {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.preview-tz {
  color: var(--mao-muted);
}

.form-warn {
  font-size: 12px;
  color: var(--mao-warn);
  line-height: 1.6;
  margin-top: 4px;
}

.switch-hint {
  margin-left: 10px;
  font-size: 13px;
  color: var(--mao-muted);
}
</style>
