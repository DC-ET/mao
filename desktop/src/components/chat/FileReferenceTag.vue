<template>
  <el-tooltip
    :content="filePath"
    placement="top"
    :show-after="300"
    :popper-options="{ strategy: 'fixed' }"
    popper-class="file-reference-tag-tip"
  >
    <span class="file-reference-tag">
      📄 {{ fileName }}
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  filePath: string
}>()

const fileName = computed(() => {
  if (!props.filePath) return ''
  const parts = props.filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || props.filePath
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
  background: #0d9488;
  color: white;
}

:root[data-theme="dark"] .file-reference-tag {
  background: #2dd4bf;
  color: #134e4a;
}
</style>
