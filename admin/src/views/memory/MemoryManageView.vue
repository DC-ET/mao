<template>
  <!-- 管理逻辑全部收敛在 MemoryManagePanel：本页=自由跨用户模式，用户详情抽屉=定人模式（fixedUserId） -->
  <MemoryManagePanel />
</template>

<script setup lang="ts">
import MemoryManagePanel from './components/MemoryManagePanel.vue'
</script>
