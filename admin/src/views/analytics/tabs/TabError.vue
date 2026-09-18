<template>
  <div class="tab-error">
    <el-result icon="error" title="加载失败" sub-title="当前模块数据请求失败，可点击重试。">
      <template #extra>
        <el-button type="primary" :loading="loading" @click="$emit('retry')">重试</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
defineProps<{ loading?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<style scoped>
.tab-error {
  padding: 24px 0;
}
</style>
