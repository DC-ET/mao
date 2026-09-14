<template>
  <section id="setting-group-ecp" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">ECP 飞书登录</span>
          <el-button type="primary" size="small" :loading="saving" :disabled="disabled" @click="save">保存</el-button>
        </div>
      </template>
      <el-alert v-if="ready && !row" type="warning" :closable="false" show-icon title="ECP 配置项未初始化" description="请先完成数据库迁移并确认配置项已初始化，再刷新页面；当前不能保存。" />
      <el-alert v-if="readError" type="error" :closable="false" show-icon :title="`ECP 配置读取失败：${readError}`" description="已禁止编辑和保存，避免覆盖现有配置。请修复配置后点击页面刷新。" />
      <el-alert type="warning" :closable="false" show-icon title="开启后将关闭密码、LDAP、Mao 飞书与公司 SSO 登录" class="config-tip" />
      <el-alert type="info" :closable="false" show-icon title="保存后对新登录与 renew 即时生效，不需重启。" class="config-tip" />
      <el-form label-width="170px" label-position="left" class="group-form" :disabled="disabled">
        <el-form-item label="启用 ECP 飞书登录">
          <el-switch v-model="model.enabled" />
        </el-form-item>
        <el-form-item label="appCode">
          <el-input v-model="model.appCode" placeholder="EK6301" />
        </el-form-item>
        <el-form-item label="ECP API Base URL">
          <el-input v-model="model.baseUrl" placeholder="https://ecp.acg.team/api/v1" />
        </el-form-item>
        <el-form-item label="loginVariant">
          <el-input v-model="model.loginVariant" placeholder="PARTNER" />
          <div class="field-hint">联调 400/401 时可调整，默认 PARTNER。</div>
        </el-form-item>
        <el-form-item label="请求超时 (ms)">
          <el-input-number v-model="model.timeoutMs" :min="1000" :max="60000" :step="1000" step-strictly controls-position="right" />
        </el-form-item>
        <el-form-item label="桌面回调 URL">
          <el-input v-model="model.desktopCallbackUrl" />
          <div class="field-hint">须在 ECP 登记；桌面 / Web / 安卓飞书回调。</div>
        </el-form-item>
        <el-form-item label="管理后台回调 URL">
          <el-input v-model="model.adminCallbackUrl" />
          <div class="field-hint">须在 ECP 登记；管理后台飞书回调。</div>
        </el-form-item>
      </el-form>
      <div class="field-hint">{{ ECP_CONFIG_KEY }} · 单条 JSON 完整快照保存</div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../api'
import { ECP_CONFIG_KEY, defaultEcpConfig, parseEcpConfig, validateEcpConfig } from '../ecpConfig'

const props = defineProps<{
  row?: { value: string | null; editable?: number }
  canWrite: boolean
  ready: boolean
}>()
const emit = defineEmits<{ (e: 'saved'): void }>()
const model = ref(defaultEcpConfig())
const readError = ref('')
const saving = ref(false)
const disabled = computed(() => !props.ready || !props.canWrite || props.row?.editable !== 1 || !!readError.value || saving.value)

watch(() => props.row?.value, (raw) => {
  readError.value = ''
  if (raw === undefined) return
  try {
    model.value = parseEcpConfig(raw)
  } catch (e) {
    readError.value = e instanceof Error ? e.message : String(e)
    model.value = defaultEcpConfig()
  }
}, { immediate: true })

async function save() {
  if (disabled.value) return
  saving.value = true
  try {
    const payload = validateEcpConfig(model.value)
    await api.put(`/system-settings/${ECP_CONFIG_KEY}`, { value: JSON.stringify(payload) })
    ElMessage.success('ECP 配置已保存')
    emit('saved')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; }
.field-hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; margin-top: 4px; }
.config-tip { margin-bottom: 12px; }
</style>
