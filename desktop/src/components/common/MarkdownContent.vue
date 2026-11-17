<template>
  <!-- 必须保持单根。父组件 scoped 排版（MessageBubble 的 .assistant-text / .markdown-body、
       文件预览、网页工具卡、技能详情）只打在子组件唯一根元素上；一旦再拆成与查看器平级的
       两个根，data-v 标记挂不上，字号会掉回 body 的 17px，表格回到浏览器默认的居中加粗。
       查看器放在根内且 teleported：不占第二个根，fixed 层也不会被裁剪，点击不冒泡回正文。 -->
  <div :class="bodyClass" @click="onBodyClick">
    <div ref="root" v-html="html"></div>
    <!-- teleported 必须显式：默认 false 原地渲染，fixed 定位会被 overflow/transform 祖先裁剪
         （ToolCallCard el-image preview-teleported 同口径）；hide-on-click-modal 显式开
         （element-plus 默认 false），全屏查看器点遮罩即退出是方案验收口径 -->
    <el-image-viewer
      v-if="previewUrl"
      :url-list="previewList"
      teleported
      hide-on-click-modal
      @close="closePreview"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import { insertMermaidDiagrams } from '../../utils/mermaid-renderer'
import { enhanceCodeBlocks, ensureCodeBlockDelegation } from '../../utils/codeBlockCollapse'
import { markZoomableImages, pickZoomImage } from '../../utils/markdownZoom'
import { decorateMarkdownImages, type MarkdownImageContext } from '../../utils/markdownImages'
import { useTheme } from '../../utils/theme'

const props = withDefaults(defineProps<{
  content: string
  bodyClass?: string
  /** 引用标记映射（回复引用溯源）：registry 序号 n → 展示序号 k。缺省时 [^n^] 按纯文本剥掉 */
  citeMap?: Record<number, number>
  /** 流式进行中：跳过 Mermaid 图渲染（占位保持代码块形态），流结束后渲染一次（技术方案 C2/C6） */
  streaming?: boolean
  /** 消息宿主专用：渲染完成后增强代码块（>30 行折叠 / 换行开关，utils/codeBlockCollapse）。
   *  缺省 false——trace / 文件预览 / 技能页等其它宿主渲染产物逐字节不变（技术方案 D6） */
  codeBlockEnhance?: boolean
  /** 正文相对图片解析用的会话 ID：CLOUD 会话的工作区文件经后端按会话归属读取。
   *  缺省不解析（图片加载失败回退为「📎 原路径」文本） */
  sessionId?: string
  /** 该会话执行模式：LOCAL 会话的工作区在本机、服务端读不到，不做地址改写 */
  sessionExecutionMode?: string
}>(), {
  bodyClass: 'markdown-body',
  codeBlockEnhance: false,
  sessionId: '',
  sessionExecutionMode: '',
})

const { isDark } = useTheme()
const html = ref('')
const root = ref<HTMLElement | null>(null)
/** 正文图片解析上下文：没有会话 ID 时传 null（保持原 src，交给失败回退） */
const imageContext = computed<MarkdownImageContext | null>(() =>
  props.sessionId ? { sessionId: props.sessionId, executionMode: props.sessionExecutionMode } : null,
)
// 渲染代际序号：流式高频触发 + 异步 renderMarkdown（Monaco 高亮较慢），
// 慢的旧帧后到会覆盖新内容导致文本闪回，用代际丢弃过期渲染结果
let renderGen = 0

// 正文图片点击放大：url 在打开瞬间定格，v-html 重建不影响已开的 viewer
const previewUrl = ref('')
const previewList = computed(() => [previewUrl.value])

function onBodyClick(e: MouseEvent) {
  const img = pickZoomImage(e.target)
  if (!img) return
  previewUrl.value = img.currentSrc || img.src
}

function closePreview() {
  previewUrl.value = ''
}

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
      // 正文相对图片（Agent 截图等）改写为可访问地址 + 失败回退文本：流式期间也处理，
      // 否则半截图片会一直显示破图图标（utils/markdownImages）。
      if (root.value) {
        decorateMarkdownImages(root.value, imageContext.value)
      }
      // v-html 重建后占位需重新渲染；流式期间跳过，streaming 翻转（含 false→渲染完成）
      // 必触发本回调补渲染（C6：流结束时 content 可能不再变化，仅靠 content watch 会漏）。
      // 过期占位由 mermaid-renderer 的 isConnected/源码校验丢弃（C4）。
      if (!streaming && root.value) {
        insertMermaidDiagrams(root.value)
        // 正文可放大图片标记（点击层只认 md-img-zoom 类，utils/markdownZoom）；
        // 流式中跳过（半张图不预览），streaming 翻转必触发本回调补标记（C6 同源）
        markZoomableImages(root.value)
        // 消息宿主代码块增强（折叠 / 换行）：与 Mermaid 同位挂 !streaming 分支（D7），
        // 过期帧在代际守卫处已 return，不会走到这里
        if (props.codeBlockEnhance) {
          enhanceCodeBlocks(root.value)
          ensureCodeBlockDelegation()
        }
      }
    })
  },
  { immediate: true },
)

// 会话上下文晚到（历史消息先渲染、会话实体后加载）时补一次图片解析：
// 重解析整段 Markdown 只为换 src 不划算，直接在现有 DOM 上重写地址。
watch([() => props.sessionId, () => props.sessionExecutionMode], async () => {
  await nextTick()
  if (root.value) decorateMarkdownImages(root.value, imageContext.value)
})
</script>
