<template>
  <div class="tab-empty">
    <el-result icon="info" :title="title" :sub-title="hint">
      <template #extra>
        <el-button type="primary" @click="$emit('relax')">放宽到近 7 天</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string
    hint?: string
  }>(),
  {
    title: '当前时间窗内没有数据',
    hint: '可能周期太短、尚无用户使用，或筛选过严。'
  }
)
defineEmits<{ relax: [] }>()
</script>

<style scoped>
.tab-empty {
  padding: 24px 0;
}
</style>
