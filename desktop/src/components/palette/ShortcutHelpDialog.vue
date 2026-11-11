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
import { SHORTCUT_ROWS } from '../../utils/shortcutRows'

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
