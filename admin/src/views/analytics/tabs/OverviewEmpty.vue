<template>
  <div class="overview-empty">
    <el-result icon="info" title="当前时间窗内没有数据" sub-title="可能周期太短、尚无用户使用，或筛选过严。">
      <template #extra>
        <el-button type="primary" @click="router.push('/agents')">去创建 Agent</el-button>
        <el-button @click="router.push('/models')">去配置模型</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<style scoped>
.overview-empty {
  padding: 24px 0;
}
</style>
