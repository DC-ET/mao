<template>
  <div :class="bodyClass" v-html="html"></div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import { useTheme } from '../../utils/theme'

const props = withDefaults(defineProps<{
  content: string
  bodyClass?: string
}>(), {
  bodyClass: 'markdown-body',
})

const { isDark } = useTheme()
const html = ref('')

watch(
  [() => props.content, isDark],
  async ([content]) => {
    html.value = content ? await renderMarkdown(content, isDark.value) : ''
  },
  { immediate: true },
)
</script>
