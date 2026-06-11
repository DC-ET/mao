<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabStore.tabs"
      :key="tab.path"
      :class="['tab-item', { active: tab.path === tabStore.activeTabPath }]"
      @click="tabStore.setActiveTab(tab.path)"
    >
      <span class="tab-title">{{ tab.title }}</span>
      <el-icon
        v-if="tab.closable"
        class="tab-close"
        @click.stop="tabStore.removeTab(tab.path)"
      >
        <Close />
      </el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTabStore } from '../stores/tabs'

const tabStore = useTabStore()
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  height: 40px;
  background: #fff;
  border-bottom: 1px solid #e6e6e6;
  padding: 0 8px;
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  margin: 0 2px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 13px;
  color: #606266;
  transition: all 0.2s;
  flex-shrink: 0;
}

.tab-item:hover {
  background: #f5f7fa;
}

.tab-item.active {
  color: #409eff;
  background: #ecf5ff;
}

.tab-close {
  font-size: 12px;
  border-radius: 50%;
  transition: all 0.2s;
}

.tab-close:hover {
  background: #c0c4cc;
  color: #fff;
}
</style>
