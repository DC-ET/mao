<template>
  <el-tooltip
    :content="filePath"
    placement="top"
    :show-after="300"
    :popper-options="{ strategy: 'fixed' }"
    popper-class="file-reference-tag-tip"
  >
    <span class="file-reference-tag">
      📄 {{ label }}
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  filePath: string
  lineStart?: number
  lineEnd?: number
}>()

const label = computed(() => {
  if (!props.filePath) return ''
  const parts = props.filePath.replace(/\\/g, '/').split('/')
  const name = parts[parts.length - 1] || props.filePath
  if (props.lineStart == null) return name
  const end = props.lineEnd ?? props.lineStart
  return end === props.lineStart ? `${name}:${props.lineStart}` : `${name}:${props.lineStart}-${end}`
})
</script>

<style>
.file-reference-tag-tip {
  max-width: 400px;
  word-break: break-word;
}
</style>

<style scoped>
.file-reference-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  line-height: 1.4;
  vertical-align: baseline;
  white-space: nowrap;
  background: var(--aw-tag-file);
  color: var(--aw-tag-file-ink);
}
</style>
