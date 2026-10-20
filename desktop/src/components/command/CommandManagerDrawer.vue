<template>
  <!--
    必须 teleport 到 body：抽屉由顶栏「我的指令」图标渲染，就地渲染会被
    .top-nav 的 overflow 裁掉。teleport 只解决裁剪；拖拽区吞点击由全局
    style.css 的 .el-overlay/.el-popper no-drag 规则解决。
    与 UsageDrawer / InboxDrawer 同一套约束，三处口径保持一致。
  -->
  <el-drawer
    v-model="visible"
    class="command-manager-drawer"
    size="min(560px, calc(100vw - 32px))"
    append-to-body
    :with-header="true"
    title="我的指令"
  >
    <CommandManager />
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import CommandManager from './CommandManager.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})
</script>
