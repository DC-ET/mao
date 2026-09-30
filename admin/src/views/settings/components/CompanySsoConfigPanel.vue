<template>
  <section id="setting-group-company-sso" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">公司 SSO</span>
          <el-button type="primary" size="small" :loading="saving" :disabled="disabled" @click="save">保存</el-button>
        </div>
      </template>
      <el-alert v-if="ready && !row" type="warning" :closable="false" show-icon title="公司 SSO 配置项未初始化" description="请先完成数据库迁移并确认配置项已初始化，再刷新页面；当前不能保存。" />
      <el-alert v-if="readError" type="error" :closable="false" show-icon :title="`公司 SSO 配置读取失败：${readError}`" description="已禁止编辑和保存，避免覆盖现有配置。请修复配置后点击页面刷新。" />
      <el-alert type="info" :closable="false" show-icon title="保存后新换票立即生效，不需重启。" class="config-tip" />
      <el-form label-width="150px" label-position="left" class="group-form" :disabled="disabled">
        <el-form-item label="启用公司 SSO">
          <el-switch v-model="model.enabled" />
          <div class="field-hint">启用时两个白名单均不能为空。</div>
        </el-form-item>
        <el-form-item label="域名白名单">
          <el-input v-model="domains" type="textarea" :rows="3" placeholder="example.com，多个域名使用英文逗号或换行分隔" />
          <div class="field-hint">允许校验 URL 的域名自身及其子域；填写至少两段的纯域名，不含 IP、协议、端口、路径或通配符。</div>
        </el-form-item>
        <el-form-item label="宿主Origin白名单">
          <el-input v-model="origins" type="textarea" :rows="3" placeholder="https://portal.example.com、https://*.example.com 或 *，多项使用英文逗号或换行分隔" />
          <div class="field-hint">支持精确 HTTPS Origin 或 https://*.example.com 子域模式；子域模式匹配任意层级子域，不含根域。默认 HTTPS 443（省略 :443），可显式指定非默认端口，如 :8443；端口须匹配。须为规范完整 Origin，不含尾部斜杠、路径、凭据、查询或片段；通配符仅限最左侧 *.，根域须为至少两段的合法 DNS 域名且不能为 IP。</div>
          <div class="field-hint">* 放开全部网页来源（包括 HTTP 和 null Origin），但仍须有效 SSO，校验域名白名单限制不变。</div>
        </el-form-item>
        <el-form-item label="访问令牌 TTL (秒)">
          <el-input-number v-model="model.accessTtlSeconds" :min="60" :max="3600" :step="1" step-strictly controls-position="right" />
          <div class="field-hint">60–3600 秒，默认 1800 秒。</div>
        </el-form-item>
        <el-form-item label="校验超时 (ms)">
          <el-input-number v-model="model.timeoutMs" :min="1" :max="30000" :step="1" step-strictly controls-position="right" />
          <div class="field-hint">1–30000 ms，默认 3000 ms。</div>
        </el-form-item>
      </el-form>
      <div class="field-hint">校验 URL 仍通过 MaoChat.init 的 auth.checkUrl 设置，不在后台配置。所有允许的校验服务必须使用同一员工身份体系。</div>
      <div class="field-hint">{{ COMPANY_SSO_KEY }} · 单条 JSON 完整快照保存</div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../api'
import { COMPANY_SSO_KEY, defaultCompanySsoConfig, parseCompanySsoConfig, splitAllowlist, validateCompanySsoConfig, type CompanySsoConfig } from '../companySsoConfig'
import { useServerSyncGuard } from '../useServerSyncGuard'

const props = defineProps<{
  row?: { value: string | null; editable?: number }
  canWrite: boolean
  ready: boolean
}>()
const emit = defineEmits<{ (e: 'saved'): void }>()
const model = ref(defaultCompanySsoConfig())
const domains = ref('')
const origins = ref('')
const readError = ref('')
const saving = ref(false)
const disabled = computed(() => !props.ready || !props.canWrite || props.row?.editable !== 1 || !!readError.value || saving.value)
const syncGuard = useServerSyncGuard()

function snapshotOf(config: CompanySsoConfig, domainsText: string, originsText: string): string {
  return JSON.stringify({ config, domainsText, originsText })
}

watch(() => props.row, async (row) => {
  let config: CompanySsoConfig
  try {
    config = parseCompanySsoConfig(row ? row.value : undefined)
  } catch (error) {
    readError.value = (error as Error).message
    return
  }
  const domainsText = config.allowedDomains.join('\n')
  const originsText = config.allowedOrigins.join('\n')
  const decision = await syncGuard.resolve(
    snapshotOf(config, domainsText, originsText),
    snapshotOf(model.value, domains.value, origins.value)
  )
  if (decision !== 'apply') return
  model.value = config
  domains.value = domainsText
  origins.value = originsText
  readError.value = ''
}, { immediate: true, deep: true })

async function save() {
  if (disabled.value) return
  let value: string
  let validated: CompanySsoConfig
  try {
    validated = validateCompanySsoConfig({
      ...model.value,
      allowedDomains: splitAllowlist(domains.value),
      allowedOrigins: splitAllowlist(origins.value),
    })
    value = JSON.stringify(validated)
  } catch (error) {
    ElMessage.error((error as Error).message)
    return
  }
  saving.value = true
  try {
    await api.put(`/system-settings/${COMPANY_SSO_KEY}`, { value })
    // 本地回写为已保存的规范化形态：父级 @saved 刷新回流时，守卫判定「服务端未变」静默覆盖，
    // 不会因 textarea 原始文本与规范化形式的格式差误报冲突
    model.value = validated
    domains.value = validated.allowedDomains.join('\n')
    origins.value = validated.allowedOrigins.join('\n')
    syncGuard.markBaseline(snapshotOf(validated, domains.value, origins.value))
    ElMessage.success('已保存，新换票立即生效，不需重启')
    emit('saved')
  } catch { /* API 拦截器已提示失败，保留编辑内容供重试 */ } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.setting-section { margin-bottom: 16px; }
.group-card { border-radius: 10px; scroll-margin-top: 12px; }
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; font-size: 14px; color: var(--mao-ink); }
.config-tip { margin-bottom: 16px; border-radius: 8px; }
.group-form :deep(.el-form-item) { margin-bottom: 14px; }
.field-hint { width: 100%; font-size: 12px; color: var(--mao-muted); line-height: 1.4; margin-top: 2px; }
</style>
