<template>
  <!--
    :key 按行变化重建内层播放器：BrowserLiveReplay 的 watch 在 sessionId/provider 变化时会
    重置到列表态，自动打开逻辑（initialLiveId）必须随每个 item 重新武装，否则与重置竞争
    （技术方案 2026-11-27 §6.4）。
  -->
  <BrowserLiveReplay :key="`${sessionId}:${liveId}`" :session-id="sessionId" :initial-live-id="liveId" />
</template>

<script setup lang="ts">
/**
 * 设置页「浏览器回放」播放弹窗的内容载体（技术方案 2026-11-27 §6.4）：复用直播 Tab 内的
 * BrowserLiveReplay 播放器，只补两件事——
 * 1. provide('executionMode')：播放器按它分流 CLOUD（axios）/ LOCAL（主进程 IPC）provider；
 * 2. 按行 :key：换行即重建，initialLiveId 自动打开重新武装。
 * 组件自身无 IO，纯装配；弹窗容器在 BrowserReplaysView。
 */
import { computed, provide } from 'vue'
import type { BrowserReplayListItem } from '@mao/contracts'
import BrowserLiveReplay from './BrowserLiveReplay.vue'

const props = defineProps<{
  sessionId: number
  liveId: string
  /** 执行模式走契约联合（勿在手写前端联合类型，AGENTS.md 规范） */
  executionMode: BrowserReplayListItem['executionMode']
}>()

// computed 而非 ref(props.executionMode)：弹窗复用同一实例切换行时，注入值要跟着 prop 变
provide('executionMode', computed(() => props.executionMode))
</script>
