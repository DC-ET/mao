<template>
  <el-dialog
    v-model="visible"
    :title="title"
    :width="isMobile ? '92%' : width"
    :fullscreen="isMobile && fullscreenOnMobile"
    :top="isMobile ? '5vh' : top"
    v-bind="$attrs"
  >
    <template v-for="(_, name) in $slots" #[name]="scope" :key="name">
      <slot :name="name" v-bind="scope || {}" />
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
