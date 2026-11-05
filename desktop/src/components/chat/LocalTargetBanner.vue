<template>
  <!-- 会话执行端提示条（技术方案 2026-11-05 §4.1-3）：LOCAL 会话且当前设备不是绑定执行端时，
       在消息列表顶部提示执行端状态；当前设备即绑定设备时完全不渲染（无信息量）。 -->
  <div
    v-if="visible"
    class="local-target-banner"
    :class="bannerState"
    role="status"
    :title="bannerText"
  >
    <el-icon :size="13" class="banner-icon">
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
  /** 绑定执行端设备名（快照）；为空表示未登记 */
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

const bannerText = computed(() => {
  if (!deviceName.value) return '该本地任务还未登记执行端，请在桌面客户端打开一次完成登记'
  if (props.targetDeviceOnline === false) return `执行端「${deviceName.value}」不在线，发送前请在该设备上打开 Mao`
  return `该任务在「${deviceName.value}」上执行`
})
</script>

<style scoped>
.local-target-banner {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  padding: 5px 10px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-64);
  font-size: var(--aw-text-fine);
  line-height: 1.4;
  width: fit-content;
  max-width: 100%;
}

.local-target-banner .banner-icon {
  flex-shrink: 0;
}

.local-target-banner .banner-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.local-target-banner.warning {
  border-color: color-mix(in srgb, var(--aw-warning) 40%, transparent);
  background: color-mix(in srgb, var(--aw-warning) 10%, var(--aw-canvas-parchment));
  color: var(--aw-warning);
}
</style>
