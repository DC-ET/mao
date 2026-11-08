<template>
  <el-dialog
    v-model="visible"
    class="shortcut-help-dialog"
    width="min(420px, calc(100vw - 32px))"
    align-center
    append-to-body
    title="快捷键速查表"
  >
    <table class="shortcut-table">
      <tbody>
        <tr v-for="row in SHORTCUT_ROWS" :key="row.keys">
          <td class="shortcut-keys"><kbd>{{ row.keys }}</kbd></td>
          <td class="shortcut-desc">{{ row.action }}</td>
        </tr>
      </tbody>
    </table>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface ShortcutRow {
  keys: string
  action: string
}

/** 7 条静态速查（技术方案 §2.3 帮助表）；键位与 TopNav handleSearchShortcut / ChatInput 既有行为一致。 */
const SHORTCUT_ROWS: ShortcutRow[] = [
  { keys: 'Ctrl/Cmd+K', action: '搜索会话' },
  { keys: 'Ctrl/Cmd+`', action: '打开/关闭终端' },
  { keys: 'Ctrl/Cmd+Shift+P', action: '命令面板' },
  { keys: '/', action: '输入框快捷指令' },
  { keys: 'Enter', action: '发送' },
  { keys: 'Shift+Enter', action: '换行' },
  { keys: 'Esc', action: '关闭浮层' }
]

const visible = ref(false)

function open() {
  visible.value = true
}

defineExpose({ open })
</script>

<style>
/* ElDialog 内容 teleport 到 body，需用非 scoped 样式 */
.shortcut-help-dialog .el-dialog__body {
  padding: 0 24px 20px;
}

.shortcut-table {
  width: 100%;
  border-collapse: collapse;
}

.shortcut-table td {
  padding: 9px 8px;
  border-bottom: 1px solid var(--aw-border);
  font-size: 13px;
  color: var(--aw-ink);
}

.shortcut-table tr:last-child td {
  border-bottom: 0;
}

.shortcut-table .shortcut-keys {
  width: 150px;
  white-space: nowrap;
}

.shortcut-table kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--aw-border);
  border-radius: 5px;
  color: var(--aw-ink-muted-80);
  background: var(--aw-surface-hover);
  font: inherit;
  font-size: 12px;
  text-align: center;
}
</style>
