<template>
  <el-dialog
    v-model="visible"
    :title="isEditing ? '编辑指令' : '新建指令'"
    width="480px"
    class="command-dialog management-dialog"
    append-to-body
    @closed="resetForm"
  >
    <el-form :model="form" label-position="top">
      <el-form-item label="指令名称" :error="nameError">
        <el-input
          v-model="form.name"
          placeholder="仅支持字母、数字、中文、下划线和连字符"
          maxlength="100"
          @input="validateName"
        />
      </el-form-item>
      <el-form-item label="指令内容">
        <el-input
          v-model="form.content"
          type="textarea"
          :rows="8"
          placeholder="请输入提示词模板内容"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <button class="dialog-btn dialog-btn-cancel" @click="visible = false">取消</button>
      <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit || submitting" @click="handleSubmit">
        {{ submitting ? '保存中…' : (isEditing ? '保存' : '创建') }}
      </button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { invalidateCommandContent } from '../../utils/commandContent'

const emit = defineEmits<{
  saved: []
}>()

const visible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const form = ref({ name: '', content: '' })
const nameError = ref('')
const submitting = ref(false)

const namePattern = /^[a-zA-Z0-9一-龥_-]+$/

const canSubmit = computed(() =>
  form.value.name.trim().length > 0 &&
  form.value.content.trim().length > 0 &&
  namePattern.test(form.value.name)
)

function validateName() {
  const name = form.value.name
  if (name.length === 0) {
    nameError.value = ''
  } else if (!namePattern.test(name)) {
    nameError.value = '名称只能包含字母、数字、中文、下划线和连字符'
  } else {
    nameError.value = ''
  }
}

/** 打开弹窗。传入 content 时为「新建 + 预填内容」（聊天「添加到我的指令」场景）。 */
function open(options?: { content?: string }) {
  // 弹窗打开中不覆盖未保存内容（保留原抽屉预填路径的互斥语义）
  if (visible.value) {
    ElMessage.warning('请先完成或关闭当前正在编辑的指令，再添加新指令')
    return
  }
  isEditing.value = false
  editingId.value = null
  form.value = { name: '', content: options?.content ?? '' }
  nameError.value = ''
  visible.value = true
}

/** 打开编辑已有指令弹窗。 */
function openEdit(cmd: { id: number; name: string; content: string }) {
  isEditing.value = true
  editingId.value = cmd.id
  form.value = { name: cmd.name, content: cmd.content }
  nameError.value = ''
  visible.value = true
}

function resetForm() {
  form.value = { name: '', content: '' }
  isEditing.value = false
  editingId.value = null
  nameError.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true

  try {
    if (isEditing.value) {
      await api.put(`/user-commands/${editingId.value}`, {
        name: form.value.name.trim(),
        content: form.value.content
      })
      ElMessage.success('指令已更新')
    } else {
      await api.post('/user-commands', {
        name: form.value.name.trim(),
        content: form.value.content
      })
      ElMessage.success('指令已创建')
    }
    visible.value = false
    invalidateCommandContent()
    emit('saved')
  } catch {
    // Error handled by interceptor
  } finally {
    submitting.value = false
  }
}

defineExpose({ open, openEdit })
</script>

<style scoped>
.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
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

<style>
.command-dialog {
  --el-font-size-base: 14px;
  --el-font-size-small: 13px;
  --el-font-size-extra-small: 12px;
}
</style>
