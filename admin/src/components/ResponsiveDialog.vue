<template>
  <el-dialog
    v-bind="$attrs"
    :model-value="modelValue"
    :title="title"
    :width="isMobile ? '92%' : width"
    :fullscreen="isMobile && fullscreenOnMobile"
    :top="isMobile ? '5vh' : top"
    :append-to-body="true"
    :destroy-on-close="true"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!--
      1) default 必须用 <slot />，不能用 v-for 动态 #[name] 转发，否则内容会泄漏到弹窗外。
      2) 当前 Element Plus 默认 appendToBody=false，Teleport 会被禁用，弹窗会留在布局内，
         看起来像「内联在页面底部」而不是遮罩弹窗，因此这里强制 append-to-body。
    -->
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
import { useBreakpoint } from '../composables/useBreakpoint'

defineOptions({ inheritAttrs: false })

withDefaults(
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
</script>
