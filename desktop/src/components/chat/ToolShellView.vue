<template>
  <!-- 终端会话块：$ 命令 + 分隔线 + 输出原文，合成一个块。命令与输出不再各占一个灰框，
       主次用提示符和分隔线表达；exit 徽标等元信息在卡片底栏，不占块内空间。 -->
  <div class="tool-shell">
    <div class="shell-scroll">
      <div v-if="command" class="cmd-line">
        <span class="cmd-prompt">{{ label === '命令' ? '$' : '›' }}</span>
        <span v-if="label !== '命令'" class="cmd-tag">{{ label }}</span>
        <span class="cmd-text">{{ command }}</span>
      </div>
      <div v-if="output || error" class="cmd-divider" />
      <pre v-if="error" class="cmd-output cmd-error">{{ error }}</pre>
      <pre v-else-if="output" class="cmd-output">{{ output }}</pre>
    </div>
    <button
      v-if="output || error"
      class="copy-btn"
      title="复制"
      @click="copy(output || error)"
    >
      <el-icon :size="14"><CopyDocument /></el-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'
import { copyText as copyToClipboard } from '../../utils/clipboard'

defineProps<{
  /** 主输入：exec 动作为命令，write_stdin 动作为 stdin 内容 */
  command: string
  /** '命令' | 'stdin'：决定提示符与标签 */
  label: string
  output: string
  /** 工具级失败（拒绝执行/参数错误等），在输出位红色直显 */
  error: string
}>()

async function copy(text: string) {
  const ok = await copyToClipboard(text)
  if (ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}
</script>

<style scoped>
.tool-shell {
  position: relative;
  margin-bottom: 8px;
  background: var(--aw-surface-code);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
}

.shell-scroll {
  max-height: 280px;
  overflow: auto;
  padding: 8px 12px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 1.5;
}

/* 提示符固定宽度，命令换行后续行与首行文本对齐（终端惯例） */
.cmd-line {
  display: flex;
  min-width: 0;
}

.cmd-prompt {
  flex-shrink: 0;
  width: 1.1em;
  color: var(--aw-primary);
  user-select: none;
}

.cmd-tag {
  flex-shrink: 0;
  margin-right: 6px;
  padding: 0 4px;
  height: 1.4em;
  line-height: 1.4;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-xs);
  user-select: none;
}

.cmd-text {
  min-width: 0;
  color: var(--aw-text-code);
  white-space: pre-wrap;
  word-break: break-all;
}

.cmd-divider {
  height: 1px;
  margin: 6px 0;
  background: var(--aw-divider-soft);
}

.cmd-output {
  margin: 0;
  color: var(--aw-text-code);
  white-space: pre;
}

.cmd-error {
  color: var(--aw-danger);
  white-space: pre-wrap;
  word-break: break-all;
}

.copy-btn {
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  padding: 0;
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-glass);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.tool-shell:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--aw-ink);
}
</style>
