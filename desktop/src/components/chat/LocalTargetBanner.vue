<template>
  <!-- 会话执行端提示（技术方案 2026-11-05 §4.1-3）：LOCAL 会话且当前设备不是绑定执行端时，
       在消息列表顶部提示执行端状态；当前设备即绑定设备时完全不渲染（无信息量）。
       视觉语言对齐对话流：info 态同时间戳（小号 muted 纯文字），warning 态同历史锚点条
      （柔和实底细条、无边框），避免像外来警告芯片。 -->
  <div
    v-if="visible"
    class="local-target-banner"
    :class="bannerState"
    role="status"
    :title="bannerText"
  >
    <el-icon :size="12" class="banner-icon">
      <WarningFilled v-if="bannerState === 'warning'" />
      <Monitor v-else />
    </el-icon>
    <span class="banner-text">{{ bannerText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { WarningFilled, Monitor } from '@element-plus/icons-vue'

const props = defineProps<{
  executionMode: string
  /** LOCAL 会话绑定的执行端设备 id（快照）；与当前设备相同即无需提示 */
  targetDeviceId?: string | null
  /** 绑定执行端设备名（快照，hostname）；为空表示未登记 */
  targetDeviceName?: string | null
  /** 快照：true=在线 / false=离线 / null=未知 */
  targetDeviceOnline?: boolean | null
  /** 当前 Electron 设备 id；浏览器 / 非桌面壳为 null（无法确认，照常提示） */
  currentDeviceId?: string | null
}>()

const deviceName = computed(() => (props.targetDeviceName ?? '').trim())

/** 当前设备就是绑定执行端时无信息量，不渲染；浏览器拿不到设备身份，照常提示。 */
const visible = computed(() => {
  if (props.executionMode !== 'LOCAL') return false
  const current = (props.currentDeviceId ?? '').trim()
  const bound = (props.targetDeviceId ?? '').trim()
  if (current !== '' && bound !== '' && current === bound) return false
  return true
})

const bannerState = computed<'warning' | 'info'>(() => {
  if (!deviceName.value || props.targetDeviceOnline === false) return 'warning'
  return 'info'
})

/** 展示名去掉 mDNS 的 .local 尾巴（title 仍挂完整名，鼠标悬停可看全） */
const displayName = computed(() => deviceName.value.replace(/\.local$/, ''))

const bannerText = computed(() => {
  if (!deviceName.value) return '该本地任务还未登记执行端，请在桌面客户端打开一次完成登记'
  if (props.targetDeviceOnline === false) return `执行端 ${displayName.value} 不在线，发送前请在该设备上打开 Mao`
  return `该任务在 ${displayName.value} 上执行`
})
</script>

<style scoped>
/* info 态：时间戳语言——小号 muted 文字，无底无边框，随消息流自然滚走 */
.local-target-banner.info {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 10px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  line-height: 1.5;
}

/* warning 态：历史锚点条语言——柔和实底细条（吸顶），warning 色文字承担严重度 */
.local-target-banner.warning {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 10px;
  padding: 5px 10px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-hover);
  color: var(--aw-warning);
  font-size: var(--aw-text-fine);
  line-height: 1.5;
}

.local-target-banner .banner-icon {
  flex-shrink: 0;
}

.local-target-banner .banner-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
