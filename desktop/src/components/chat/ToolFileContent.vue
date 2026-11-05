<template>
  <!-- 行号列 + 代码块双列：monaco 着色产物是整段 HTML（跨行 span 无法按行拆），
       行号独立成列、代码整块渲染，两者行高一致即逐行对齐；横向滚动行号列sticky 跟随。 -->
  <div class="tool-file-content">
    <div v-if="numbered" class="file-cols">
      <div class="line-no-col">
        <div v-for="n in lineCount" :key="n" class="line-no">{{ startLine + n - 1 }}</div>
      </div>
      <pre v-if="highlighted" class="file-code" v-html="highlighted"></pre>
      <pre v-else class="file-code"><code>{{ content }}</code></pre>
    </div>
    <pre v-else class="file-plain"><code>{{ content }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTheme } from '../../utils/theme'
import { colorizeCode } from '../../utils/monaco-colorize'
import { monacoLangFromExtension } from '../../utils/monaco-lang'

const props = withDefaults(defineProps<{
  content: string
  /** 文件路径：仅用于按扩展名推断语言做语法高亮，缺省或 plaintext 类型不高亮 */
  filePath?: string
  /** 首行行号：read_file 带 offset 分页读取时从 offset+1 起算 */
  startLine?: number
  numbered?: boolean
}>(), {
  filePath: '',
  startLine: 1,
  numbered: true,
})

/** 超过此行数放弃行号槽：DOM 行数随文件线性增长，超长文件限高滚动 + 纯文本块已足够阅读 */
const MAX_NUMBERED_LINES = 2000

const lineCount = computed(() => props.content.split('\n').length)
const numbered = computed(() => props.numbered && lineCount.value <= MAX_NUMBERED_LINES)

const { isDark } = useTheme()
const highlighted = ref('')
/** 着色是异步的：内容/主题连续变化时只认最后一次结果，避免旧着色覆盖新内容 */
let colorizeToken = 0

async function refreshHighlight() {
  const token = ++colorizeToken
  if (!numbered.value || !props.filePath || props.content === '') {
    highlighted.value = ''
    return
  }
  const language = monacoLangFromExtension(props.filePath)
  if (language === 'plaintext') {
    highlighted.value = ''
    return
  }
  try {
    const html = await colorizeCode(props.content, language, isDark.value)
    if (token === colorizeToken) highlighted.value = html
  } catch {
    // monaco 加载/着色失败：回落纯文本，不影响阅读
    if (token === colorizeToken) highlighted.value = ''
  }
}

watch([() => props.content, () => props.filePath, () => props.numbered, isDark], refreshHighlight, { immediate: true })
</script>

<style scoped>
.tool-file-content {
  margin-bottom: 8px;
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow: auto;
  max-height: 320px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 1.5;
}

.file-cols {
  display: flex;
  min-width: min-content;
  padding: 8px 0;
}

/* 行号列吸顶：代码横向滚动时保持可见，底色与块背景一致遮住滚过的代码 */
.line-no-col {
  position: sticky;
  left: 0;
  z-index: 1;
  flex-shrink: 0;
  width: 44px;
  padding: 0 10px 0 12px;
  text-align: right;
  background: var(--aw-surface-code);
  color: var(--aw-ink-muted-48);
  user-select: none;
}

.line-no {
  height: 1.5em;
}

.file-code {
  margin: 0;
  padding: 0 12px 0 0;
  color: var(--aw-text-code);
  white-space: pre;
}

/* monaco 着色产物：外层已提供背景/等宽字体/行高，这里只透传，避免双重 padding 破坏行对齐 */
.file-code :deep(.monaco-code) {
  display: block;
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  white-space: inherit;
}

.file-plain {
  margin: 0;
  padding: 8px 12px;
}

.file-plain code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
  white-space: pre;
}
</style>
