<template>
  <!-- Skill 知识文档通过文件系统管理，此组件保留为查看用途 -->
  <el-dialog
    :model-value="visible"
    title="Skill 文档详情"
    width="600px"
    @close="$emit('update:visible', false)"
  >
    <el-descriptions :column="1" border>
      <el-descriptions-item label="名称">{{ skillData?.name }}</el-descriptions-item>
      <el-descriptions-item label="描述">{{ skillData?.description }}</el-descriptions-item>
      <el-descriptions-item label="文件路径">{{ skillData?.filePath }}</el-descriptions-item>
    </el-descriptions>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
  skillData?: any | null
}>()

defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()
</script>
