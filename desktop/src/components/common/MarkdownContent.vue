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
// 渲染代际序号：流式高频触发 + 异步 renderMarkdown（Monaco 高亮较慢），
// 慢的旧帧后到会覆盖新内容导致文本闪回，用代际丢弃过期渲染结果
let renderGen = 0

watch(
  [() => props.content, isDark],
  async ([content]) => {
    const gen = ++renderGen
    const next = content ? await renderMarkdown(content, isDark.value) : ''
    if (gen !== renderGen) return
    html.value = next
    // renderMarkdown 为异步渲染（含代码块高亮），渲染完成后内容高度才最终确定。
    // 派发事件供外层（如会话恢复后的自动滚动）在高度变化后重新测量/滚动到底部。
    nextTick(() => {
      window.dispatchEvent(new CustomEvent('mao:markdown-rendered'))
    })
  },
  { immediate: true },
)
</script>
