<template>
  <div class="mcp-servers-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">MCP 服务器</h1>
        <p class="page-desc">
          在此选择你在会话中启用的 MCP 服务器。关闭后，你的会话将不再注入该服务器暴露的工具。
          服务器配置（命令、URL、环境变量）由管理员统一维护，此处仅控制开关。
        </p>
      </div>
    </header>

    <div v-if="loading" class="empty-state">加载中...</div>

    <div v-else-if="servers.length === 0" class="empty-state">
      <p>暂无可用 MCP 服务器。请联系管理员在管理后台配置并启用 MCP 服务器。</p>
    </div>

    <div v-else class="server-list">
      <div v-for="server in servers" :key="server.id" class="server-card">
        <div class="server-info">
          <div class="server-name-row">
            <span class="server-name">{{ server.name }}</span>
            <el-tag :type="server.serverType === 'STDIO' ? 'warning' : 'primary'" size="small">
              {{ server.serverType }}
            </el-tag>
          </div>
          <div v-if="server.description" class="server-desc">{{ server.description }}</div>
        </div>
        <el-switch
          :model-value="server.userEnabled"
          :loading="savingId === server.id"
          @change="(val: string | number | boolean) => handleToggle(server, !!val)"
        />
      </div>
      <p class="page-hint">停用仅影响你本人的会话；管理后台全局停用的服务器不会出现在此列表。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getMcpServerPreferences,
  saveMcpServerPreference,
  type McpServerPreferenceItem
} from '../../api'

const loading = ref(true)
const savingId = ref<number | null>(null)
const servers = ref<McpServerPreferenceItem[]>([])

onMounted(load)

async function load() {
  loading.value = true
  try {
    servers.value = (await getMcpServerPreferences()) || []
  } finally {
    loading.value = false
  }
}

async function handleToggle(server: McpServerPreferenceItem, enabled: boolean) {
  // 乐观更新
  const previous = server.userEnabled
  server.userEnabled = enabled
  savingId.value = server.id
  try {
    await saveMcpServerPreference(server.id, enabled)
    ElMessage.success(enabled ? `已启用 ${server.name}` : `已停用 ${server.name}`)
  } catch {
    // 失败回滚
    server.userEnabled = previous
  } finally {
    savingId.value = null
  }
}
</script>

<style scoped>
.mcp-servers-page {
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.page-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.page-desc {
  margin: 0;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 13px;
  line-height: 1.6;
}

.empty-state {
  padding: 40px 0;
  text-align: center;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 14px;
}

.server-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.server-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--aw-divider-soft, #e6e6e6);
  border-radius: 8px;
  background: var(--aw-surface, #fff);
}

.server-info {
  min-width: 0;
}

.server-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.server-name {
  font-weight: 600;
  font-size: 14px;
}

.server-desc {
  color: var(--aw-ink-muted, #8b949e);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.page-hint {
  margin: 4px 0 0;
  color: var(--aw-ink-muted, #8b949e);
  font-size: 12px;
}
</style>
