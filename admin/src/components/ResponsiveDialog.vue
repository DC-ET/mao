<template>
  <el-dialog
    v-model="visible"
    :title="title"
    :width="isMobile ? '92%' : width"
    :fullscreen="isMobile && fullscreenOnMobile"
    :top="isMobile ? '5vh' : top"
    v-bind="$attrs"
  >
    <!-- default 必须用 <slot /> 直接作为 el-dialog 子节点；
         用 v-for 动态 #[name] 转发 default 时，内容会泄漏到弹窗外，内联显示在页面上 -->
    <slot />
    <template v-if="$slots.header" #header="scope">
      <slot name="header" v-bind="scope || {}" />
    </template>
    <template v-if="$slots.title" #title>
      <slot name="title" />
    </template>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useBreakpoint } from '../composables/useBreakpoint'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title?: string
    width?: string
    top?: string
    fullscreenOnMobile?: boolean
  }>(),
  {
    title: '',
    width: '480px',
    top: '15vh',
    fullscreenOnMobile: true
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const { isMobile } = useBreakpoint()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})
</script>
