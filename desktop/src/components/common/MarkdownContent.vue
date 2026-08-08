<template>
  <div :class="bodyClass" v-html="html"></div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
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
    // renderMarkdown 为异步渲染（含代码块高亮），渲染完成后内容高度才最终确定。
    // 派发事件供外层（如会话恢复后的自动滚动）在高度变化后重新测量/滚动到底部。
    nextTick(() => {
      window.dispatchEvent(new CustomEvent('mao:markdown-rendered'))
    })
  },
  { immediate: true },
)
</script>
