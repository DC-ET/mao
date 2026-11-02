<template>
  <section id="setting-group-container-hosts" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">容器域名解析</span>
          <el-button size="small" :loading="previewLoading" @click="fetchPreview">刷新生效条目</el-button>
        </div>
      </template>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="仅 Docker 模式生效。创建容器时把「宿主机 /etc/hosts 自定义条目 + 下方规则」注入容器；配置保存后该用户容器在下次使用时自动重建，如需立即生效可在「容器管理」中重建。与继承条目同名时以自定义规则为准。"
        class="config-tip"
      />

      <div :id="CONTAINER_INHERIT_FIELD_ID" class="setting-field switch-row">
        <span class="switch-label">自动继承宿主机 /etc/hosts</span>
        <el-switch
          :model-value="inheritEnabled"
          :disabled="!canWrite || savingInherit"
          :loading="savingInherit"
          @change="saveInherit"
        />
      </div>

      <div class="sub-title">当前生效条目（实际注入容器的 /etc/hosts）</div>
      <el-table :data="previewEntries" v-loading="previewLoading" size="small" stripe>
        <template #empty><el-empty description="暂无生效条目" :image-size="48" /></template>
        <el-table-column prop="host" label="域名" min-width="220" show-overflow-tooltip />
        <el-table-column prop="ip" label="IP" width="160" />
        <el-table-column label="来源" width="110">
          <template #default="{ row }">{{ row.source === 'custom' ? '自定义' : '宿主机继承' }}</template>
        </el-table-column>
      </el-table>
      <div v-if="previewError" class="field-error">宿主机 /etc/hosts 读取失败：{{ previewError }}</div>

      <el-divider />

      <div :id="CONTAINER_EXTRA_HOSTS_FIELD_ID" class="setting-field">
      <div class="group-header">
        <span class="sub-title">自定义规则</span>
        <el-button type="primary" size="small" :disabled="!canWrite" @click="openCreate">新增规则</el-button>
      </div>
      <el-table :data="customEntries" size="small" stripe>
        <template #empty><el-empty description="暂无自定义规则" :image-size="48" /></template>
        <el-table-column prop="host" label="域名" min-width="220" show-overflow-tooltip />
        <el-table-column prop="ip" label="IP" width="160" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ $index }">
            <el-button type="primary" link size="small" :disabled="!canWrite" @click="openEdit($index)">编辑</el-button>
            <el-button type="danger" link size="small" :disabled="!canWrite" @click="removeEntry($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="parseError" class="field-error">当前设置值无法解析（{{ parseError }}），保存新规则将覆盖原值。</div>
      </div>

      <el-dialog
        v-model="dialogVisible"
        :title="editingIndex == null ? '新增容器域名解析规则' : '编辑容器域名解析规则'"
        width="460px"
        append-to-body
        destroy-on-close
        @closed="resetForm"
      >
        <el-form label-position="top">
          <el-form-item label="域名">
            <el-input v-model="form.host" placeholder="如 prometheus.acg.team" @input="validateForm" />
          </el-form-item>
          <el-form-item label="IP（IPv4）">
            <el-input v-model="form.ip" placeholder="如 10.70.21.57" @input="validateForm" />
          </el-form-item>
          <div v-if="formError" class="field-error">{{ formError }}</div>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :disabled="!!formError || !form.host || !form.ip" @click="submit">确定</el-button>
        </template>
      </el-dialog>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'
import {
  containerHostEntryError,
  containerHostsSaveError,
  parseContainerHostsValue,
  stringifyContainerHosts,
  type ContainerHostEntry,
} from '../containerHosts'
import { CONTAINER_EXTRA_HOSTS_FIELD_ID, CONTAINER_INHERIT_FIELD_ID } from '../settingsSearchCatalog'

const CONTAINER_INHERIT_KEY = 'runtime.container.inheritHostHosts'
const CONTAINER_EXTRA_HOSTS_KEY = 'runtime.container.extraHosts'

const props = defineProps<{
  canWrite: boolean
  inheritRow?: { value?: string | null } | null
  extraHostsRow?: { value?: string | null } | null
}>()

const emit = defineEmits<{ (e: 'saved'): void }>()

// —— 继承开关 ——
const inheritEnabled = computed(() => (props.inheritRow?.value ?? 'true').trim().toLowerCase() !== 'false')
const savingInherit = ref(false)

async function saveInherit(next: string | number | boolean) {
  const value = next === true ? 'true' : 'false'
  savingInherit.value = true
  try {
    await api.put(`/system-settings/${CONTAINER_INHERIT_KEY}`, { value })
    ElMessage.success(value === 'true' ? '已开启宿主机 hosts 继承' : '已关闭宿主机 hosts 继承')
    emit('saved')
    void fetchPreview()
  } catch { /* 拦截器已提示失败 */ } finally {
    savingInherit.value = false
  }
}

// —— 生效条目预览 ——
interface PreviewEntry extends ContainerHostEntry { source: 'hosts-file' | 'custom' }
const previewEntries = ref<PreviewEntry[]>([])
const previewError = ref<string | null>(null)
const previewLoading = ref(false)

async function fetchPreview() {
  previewLoading.value = true
  try {
    const { data } = await api.get('/system-settings/container-hosts/preview')
    previewEntries.value = data?.entries ?? []
    previewError.value = data?.hostsFileError ?? null
  } catch { /* 拦截器已提示失败 */ } finally {
    previewLoading.value = false
  }
}

// —— 自定义规则 ——
const customEntries = ref<ContainerHostEntry[]>([])
const parseError = ref<string | null>(null)

function syncFromRow(row?: { value?: string | null } | null) {
  const { entries, error } = parseContainerHostsValue(row?.value)
  customEntries.value = entries
  parseError.value = error
}

watch(() => props.extraHostsRow?.value, () => syncFromRow(props.extraHostsRow), { immediate: true })

const dialogVisible = ref(false)
const editingIndex = ref<number | null>(null)
const form = reactive({ host: '', ip: '' })
const formError = ref('')

function validateForm() {
  formError.value = form.host || form.ip ? (containerHostEntryError(form.host, form.ip) ?? '') : ''
}

function openCreate() {
  editingIndex.value = null
  form.host = ''
  form.ip = ''
  formError.value = ''
  dialogVisible.value = true
}

function openEdit(index: number) {
  const entry = customEntries.value[index]!
  editingIndex.value = index
  form.host = entry.host
  form.ip = entry.ip
  formError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  editingIndex.value = null
  form.host = ''
  form.ip = ''
  formError.value = ''
}

async function persist(entries: ContainerHostEntry[]) {
  const error = containerHostsSaveError(entries)
  if (error != null) {
    ElMessage.error(error)
    return false
  }
  await api.put(`/system-settings/${CONTAINER_EXTRA_HOSTS_KEY}`, { value: stringifyContainerHosts(entries) })
  return true
}

async function submit() {
  validateForm()
  if (formError.value || !form.host || !form.ip) return
  const entry = { host: form.host, ip: form.ip }
  const next = editingIndex.value == null
    ? [...customEntries.value, entry]
    : customEntries.value.map((item, index) => (index === editingIndex.value ? entry : item))
  try {
    const ok = await persist(next)
    if (!ok) return
    ElMessage.success(editingIndex.value == null ? '规则已新增' : '规则已更新')
    dialogVisible.value = false
    emit('saved')
    void fetchPreview()
  } catch { /* 拦截器已提示失败 */ }
}

async function removeEntry(index: number) {
  const entry = customEntries.value[index]!
  try {
    await ElMessageBox.confirm(`确定删除规则 ${entry.host} → ${entry.ip} 吗？`, '删除容器域名解析规则', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
  } catch {
    return
  }
  try {
    const ok = await persist(customEntries.value.filter((_, i) => i !== index))
    if (!ok) return
    ElMessage.success('已删除')
    emit('saved')
    void fetchPreview()
  } catch { /* 拦截器已提示失败 */ }
}

void fetchPreview()
</script>

<style scoped>
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; }
.sub-title { font-weight: 600; margin-bottom: 8px; }
.config-tip { margin-bottom: 12px; }
.switch-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.switch-label { font-size: 13px; color: var(--el-text-color-regular); }
.field-error { color: var(--el-color-danger); font-size: 12px; margin-top: 6px; }
</style>

