<template>
  <!-- 多根模板（viewer 与宿主 div 平级）：fallthrough 失效，attrs（如 ToolWebPageView 的
       class="page-body"）由脚本 v-bind 到宿主 div 上，透传行为与单根时代逐字节一致 -->
  <div ref="root" :class="bodyClass" v-bind="attrs" v-html="html" @click="onBodyClick"></div>
  <!-- 正文图片点击放大（utils/markdownZoom）。teleported 必须显式：默认 false 原地渲染，
       fixed 定位会被 overflow/transform 祖先裁剪（ToolCallCard el-image preview-teleported 同口径）；
       hide-on-click-modal 显式开（element-plus 默认 false），全屏查看器点遮罩即退出是方案验收口径；
       teleport 到 body 后 viewer 内点击不再冒泡回 root，委托零误开 -->
  <el-image-viewer
    v-if="previewUrl"
    :url-list="previewList"
    teleported
    hide-on-click-modal
    @close="closePreview"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, useAttrs } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown'
import { insertMermaidDiagrams } from '../../utils/mermaid-renderer'
import { enhanceCodeBlocks, ensureCodeBlockDelegation } from '../../utils/codeBlockCollapse'
import { markZoomableImages, pickZoomImage } from '../../utils/markdownZoom'
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
}>(), {
  bodyClass: 'markdown-body',
  codeBlockEnhance: false,
})

const { isDark } = useTheme()
const attrs = useAttrs()
const html = ref('')
const root = ref<HTMLElement | null>(null)
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
</script>
