<template>
  <div class="experience-library">
    <el-alert
      class="library-notice"
      title="经验库存放于服务器共享目录（跨会话、跨成员）。Agent 在 CLOUD 会话中通过工作区的 团队经验/ 目录读写；INDEX.md 由系统自动生成，请勿手改。"
      type="info"
      :closable="false"
      show-icon
    />

    <el-card v-loading="store.overviewLoading && store.libraries.length === 0">
      <template #header>
        <div class="card-header">
          <span>团队经验库</span>
          <div class="header-actions">
            <span v-if="store.selectedAgentId != null" class="switch-wrap">
              <span class="switch-label">启用团队经验库</span>
              <el-switch
                :model-value="store.enabled"
                :loading="store.toggling"
                :disabled="!canWrite"
                aria-label="启用团队经验库"
                @change="onToggleEnabled"
              />
              <span class="switch-hint">{{ store.enabled ? 'CLOUD 会话挂载 团队经验/ 并注入路标' : '不挂载、不注入提示词；文档仍可在此维护' }}</span>
            </span>
            <el-button
              :disabled="store.selectedAgentId == null"
              :loading="store.rebuilding"
              title="强制重建该库的 INDEX.md"
              aria-label="重建索引"
              @click="store.rebuildIndex()"
            >重建索引</el-button>
            <el-button :disabled="store.listLoading" title="刷新" aria-label="刷新列表" @click="store.reloadAll()">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <!-- 整页两级切换（不做左右/上下分栏）：无打开文档 = 全宽列表页；打开文档/索引/新建 = 整页替换为阅读器，
           由 URL file 参数驱动（返回列表/浏览器前进后退均可导航） -->
      <DocListPanel v-if="store.viewer == null" />
      <DocViewer v-else :payload="store.viewer" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, provide } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { useAuthStore } from '../../stores/auth'
import DocListPanel from './components/DocListPanel.vue'
import DocViewer from './components/DocViewer.vue'
import { EXPERIENCE_LIBRARY_KEY, useExperienceLibrary } from './composables/useExperienceLibrary'

const store = useExperienceLibrary()
provide(EXPERIENCE_LIBRARY_KEY, store)

const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

function onToggleEnabled(value: string | number | boolean): void {
  void store.toggleEnabled(!!value)
}
</script>

<style scoped>
.experience-library {
  min-width: 0;
}
.library-notice {
  margin-bottom: 12px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.switch-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.switch-label {
  font-weight: 600;
}
.switch-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
