<template>
  <!--
    必须 teleport 到 body：抽屉由顶栏「我的指令」图标渲染，而 .top-nav 带
    -webkit-app-region: drag（Electron 窗口拖拽区），仅 .nav-right 自身盒子是
    no-drag。留在原处时抽屉头部会伸进拖拽区，落在那里的点击被系统吞掉。
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
