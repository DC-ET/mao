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

      <div class="library-layout">
        <LibrarySidebar v-if="!isMobile" class="col-sidebar" />
        <div v-else class="mobile-agent-select">
          <el-select
            :model-value="store.selectedAgentId"
            placeholder="选择 Agent 库"
            filterable
            aria-label="选择 Agent 经验库"
            @update:model-value="store.selectAgent(Number($event))"
          >
            <el-option
              v-for="lib in store.libraries"
              :key="lib.agentId"
              :value="lib.agentId"
              :label="lib.agentName"
            >
              {{ lib.agentName }}（{{ lib.docCount }} 篇{{ lib.enabled ? '' : '，已停用' }}）
            </el-option>
          </el-select>
        </div>

        <DocListPanel class="col-list" />

        <DocViewer v-if="store.viewer != null" ref="viewerRef" class="col-viewer" :payload="store.viewer" />
        <div v-else class="col-viewer viewer-placeholder">
          <el-empty description="点击左侧文档阅读；「索引」查看自动生成的 INDEX.md" :image-size="80" />
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { useAuthStore } from '../../stores/auth'
import { useBreakpoint } from '../../composables/useBreakpoint'
import LibrarySidebar from './components/LibrarySidebar.vue'
import DocListPanel from './components/DocListPanel.vue'
import DocViewer from './components/DocViewer.vue'
import { EXPERIENCE_LIBRARY_KEY, useExperienceLibrary } from './composables/useExperienceLibrary'

const store = useExperienceLibrary()
provide(EXPERIENCE_LIBRARY_KEY, store)

const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))
const { isMobile } = useBreakpoint()

function onToggleEnabled(value: string | number | boolean): void {
  void store.toggleEnabled(!!value)
}

// 窄屏（≤1280px）右栏折到列表下方：打开文档时滚动定位，避免读者找不到右栏（与 style 中 CSS 断点一致）
const NARROW_VIEW_BREAKPOINT = 1280
const viewerRef = ref<InstanceType<typeof DocViewer> | null>(null)
watch(() => store.viewer, async (value) => {
  if (value == null) return
  await nextTick()
  if (typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEW_BREAKPOINT) {
    ;(viewerRef.value?.$el as HTMLElement | undefined)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})
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
.library-layout {
  display: grid;
  grid-template-columns: 260px minmax(380px, 36%) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1280px) {
  .library-layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  .col-viewer {
    grid-column: 1 / -1;
  }
}
@media (max-width: 768px) {
  .library-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.mobile-agent-select {
  width: 100%;
}
.viewer-placeholder {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
