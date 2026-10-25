<template>
  <div ref="root" :class="bodyClass" v-html="html"></div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import { insertMermaidDiagrams } from '../../utils/mermaid-renderer'
import { useTheme } from '../../utils/theme'

const props = withDefaults(defineProps<{
  content: string
  bodyClass?: string
  /** 引用标记映射（回复引用溯源）：registry 序号 n → 展示序号 k。缺省时 [^n^] 按纯文本剥掉 */
  citeMap?: Record<number, number>
  /** 流式进行中：跳过 Mermaid 图渲染（占位保持代码块形态），流结束后渲染一次（技术方案 C2/C6） */
  streaming?: boolean
}>(), {
  bodyClass: 'markdown-body',
})

const { isDark } = useTheme()
const html = ref('')
const root = ref<HTMLElement | null>(null)
// 渲染代际序号：流式高频触发 + 异步 renderMarkdown（Monaco 高亮较慢），
// 慢的旧帧后到会覆盖新内容导致文本闪回，用代际丢弃过期渲染结果
let renderGen = 0

watch(
  [() => props.content, isDark, () => props.citeMap, () => props.streaming],
  async ([content, , citeMap, streaming]) => {
    const gen = ++renderGen
    const next = content ? await renderMarkdown(content, isDark.value, citeMap) : ''
    if (gen !== renderGen) return
    html.value = next
    // renderMarkdown 为异步渲染（含代码块高亮），渲染完成后内容高度才最终确定。
    // 派发事件供外层（如会话恢复后的自动滚动）在高度变化后重新测量/滚动到底部。
    nextTick(() => {
      window.dispatchEvent(new CustomEvent('mao:markdown-rendered'))
      // v-html 重建后占位需重新渲染；流式期间跳过，streaming 翻转（含 false→渲染完成）
      // 必触发本回调补渲染（C6：流结束时 content 可能不再变化，仅靠 content watch 会漏）。
      // 过期占位由 mermaid-renderer 的 isConnected/源码校验丢弃（C4）。
      if (!streaming && root.value) {
        insertMermaidDiagrams(root.value)
      }
    })
  },
  { immediate: true },
)
</script>
