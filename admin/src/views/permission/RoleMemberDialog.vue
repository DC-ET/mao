<template>
  <ResponsiveDialog
    :model-value="modelValue"
    :title="`管理成员${role ? ` - ${role.name}` : ''}`"
    width="980px"
    top="8vh"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="rm-tip">
      勾选或点行内按钮即时生效；勾选在翻页和搜索间保留，可搜一个勾一个后一次性移过去。
    </p>

    <div v-if="role" class="rm-transfer">
      <RoleMemberPanel
        ref="candidatePanel"
        v-model:selected="candidateSelected"
        mode="candidates"
        title="未加入"
        :role-id="role.id"
        :busy="!!submitting"
        :flash-ids="candidateFlash"
        @quick="(row) => addUsers([row])"
      />

      <div class="rm-actions">
        <el-button
          type="primary"
          :disabled="candidateSelected.size === 0"
          :loading="submitting === 'add'"
          :title="`把左侧已选的 ${candidateSelected.size} 人加入角色`"
          @click="addUsers([...candidateSelected.values()])"
        >
          添加{{ candidateSelected.size ? ` ${candidateSelected.size}` : '' }}
          <el-icon class="el-icon--right"><component :is="isMobile ? ArrowDown : ArrowRight" /></el-icon>
        </el-button>
        <el-button
          type="danger"
          plain
          :disabled="memberSelected.size === 0"
          :loading="submitting === 'remove'"
          :title="`把右侧已选的 ${memberSelected.size} 人移出角色`"
          @click="removeUsers([...memberSelected.values()])"
        >
          <el-icon class="el-icon--left"><component :is="isMobile ? ArrowUp : ArrowLeft" /></el-icon>
          移出{{ memberSelected.size ? ` ${memberSelected.size}` : '' }}
        </el-button>
      </div>

      <RoleMemberPanel
        ref="memberPanel"
        v-model:selected="memberSelected"
        mode="members"
        title="当前成员"
        :role-id="role.id"
        :busy="!!submitting"
        :flash-ids="memberFlash"
        @quick="(row) => removeUsers([row])"
      />
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">完成</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { h, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import RoleMemberPanel from './RoleMemberPanel.vue'
import type { RoleMemberUser } from './roleMemberQuery'

interface RoleTarget {
  id: number
  name: string
  userCount?: number
}

const props = defineProps<{
  modelValue: boolean
  role: RoleTarget | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  /** 增删成员成功后触发，父组件重拉角色列表刷新用户数 */
  (e: 'changed'): void
}>()

/** 服务端单次批量上限。 */
const BATCH_LIMIT = 100

const auth = useAuthStore()
const { isMobile } = useBreakpoint()
const submitting = ref<false | 'add' | 'remove'>(false)
const candidateSelected = ref(new Map<number, RoleMemberUser>())
const memberSelected = ref(new Map<number, RoleMemberUser>())
const candidateFlash = ref(new Set<number>())
const memberFlash = ref(new Set<number>())
const candidatePanel = ref<InstanceType<typeof RoleMemberPanel> | null>(null)
const memberPanel = ref<InstanceType<typeof RoleMemberPanel> | null>(null)

function withoutIds(map: Map<number, RoleMemberUser>, ids: number[]) {
  const next = new Map(map)
  for (const id of ids) next.delete(id)
  return next
}

let flashTimer: ReturnType<typeof setTimeout> | null = null
function flash(target: typeof memberFlash, ids: number[]) {
  target.value = new Set(ids)
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    candidateFlash.value = new Set()
    memberFlash.value = new Set()
  }, 1800)
}

async function refreshBoth() {
  await Promise.all([candidatePanel.value?.refresh(), memberPanel.value?.refresh()])
}

function tooMany(users: RoleMemberUser[]): boolean {
  if (users.length <= BATCH_LIMIT) return false
  ElMessage.warning(`单次最多 ${BATCH_LIMIT} 人，当前已选 ${users.length} 人`)
  return true
}

async function addUsers(users: RoleMemberUser[], silent = false): Promise<boolean> {
  if (submitting.value || !props.role || users.length === 0 || tooMany(users)) return false
  submitting.value = 'add'
  const ids = users.map((u) => u.id)
  try {
    const { data } = await api.post(`/roles/${props.role.id}/users`, { userIds: ids })
    candidateSelected.value = withoutIds(candidateSelected.value, ids)
    if (!silent) ElMessage.success(`已添加 ${data?.added ?? 0} 人`)
    await refreshBoth()
    flash(memberFlash, ids)
    emit('changed')
    return true
  } catch {
    return false /* 拦截器已提示失败 */
  } finally {
    submitting.value = false
  }
}

async function removeUsers(users: RoleMemberUser[]) {
  if (submitting.value || !props.role || users.length === 0 || tooMany(users)) return
  const role = props.role
  // 移出自己可能立刻失去管理权限、无法再撤销，只有这种情况才二次确认
  if (auth.user && users.some((u) => u.id === auth.user?.id)) {
    try {
      await ElMessageBox.confirm(
        `选中的人包含你自己。移出角色「${role.name}」后你可能立即失去相应权限，确定继续吗？`,
        '移出成员',
        { type: 'warning', confirmButtonText: '移出', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  submitting.value = 'remove'
  const ids = users.map((u) => u.id)
  try {
    const { data } = await api.delete(`/roles/${role.id}/users`, { data: { userIds: ids } })
    memberSelected.value = withoutIds(memberSelected.value, ids)
    showUndo(`已移出 ${data?.removed ?? 0} 人`, users)
    await refreshBoth()
    flash(candidateFlash, ids)
    emit('changed')
  } catch { /* 拦截器已提示失败 */ } finally {
    submitting.value = false
  }
}

function showUndo(text: string, users: RoleMemberUser[]) {
  const msg = ElMessage({
    type: 'success',
    duration: 6000,
    message: h('span', { class: 'rm-undo-msg' }, [
      text,
      h('button', {
        type: 'button',
        class: 'rm-undo-btn',
        onClick: () => {
          msg.close()
          void addUsers(users, true).then((ok) => { if (ok) ElMessage.success('已撤销') })
        },
      }, '撤销'),
    ]),
  })
}

// 打开弹窗（或切换目标角色）时清空勾选；两栏自身随 roleId 重拉
watch(
  () => [props.modelValue, props.role?.id] as const,
  ([visible]) => {
    if (!visible) return
    candidateSelected.value = new Map()
    memberSelected.value = new Map()
  },
  { immediate: true },
)
</script>

<style scoped>
.rm-tip {
  margin: -4px 0 12px;
  color: var(--mao-muted, #6e6e73);
  font-size: 12px;
}

.rm-transfer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 14px;
  align-items: stretch;
}

.rm-actions {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
}

.rm-actions .el-button + .el-button {
  margin-left: 0;
}

@media (max-width: 768px) {
  .rm-transfer {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }

  .rm-actions {
    flex-direction: row;
  }

  .rm-actions .el-button {
    flex: 1;
  }
}
</style>

<style>
.rm-undo-msg {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.rm-undo-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--mao-accent, #0066cc);
  cursor: pointer;
}
</style>
