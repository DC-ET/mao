<template>
  <div class="user-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>用户活跃排行</span>
          <span class="card-hint">按窗口内消息数 Top 10</span>
        </div>
      </template>
      <BaseChart
        :option="rankBarOption(messageItems, CHART_PALETTE[1])"
        :empty="messageItems.length === 0"
        :height="Math.max(200, messageItems.length * 34 + 32)"
      />
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>用户 Token 排行</span>
          <el-button type="primary" link @click="go('/users')">用户管理</el-button>
        </div>
      </template>
      <BaseChart
        :option="rankBarOption(tokenItems, CHART_PALETTE[0])"
        :empty="tokenItems.length === 0"
        :height="Math.max(200, tokenItems.length * 34 + 32)"
      />
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>用户用量明细</span>
          <span class="card-hint">Top {{ userRows.length }}</span>
        </div>
      </template>
      <el-table :data="userRows" size="small" stripe>
        <template #empty>
          <el-empty description="窗口内暂无用户活跃" :image-size="48" />
        </template>
        <el-table-column label="用户" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <button class="linkish" type="button" @click="go(`/sessions?userId=${row.userId}`)">
              {{ row.displayName || row.username || '未知' }}
            </button>
          </template>
        </el-table-column>
        <el-table-column prop="username" label="账号" width="120" class-name="hide-on-mobile" />
        <el-table-column label="会话" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.sessionCount) }}</template>
        </el-table-column>
        <el-table-column label="消息" width="90" align="right">
          <template #default="{ row }">{{ formatNumber(row.messageCount) }}</template>
        </el-table-column>
        <el-table-column label="Token" width="120" align="right">
          <template #default="{ row }">
            <strong>{{ formatNumber(row.totalTokens) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="调用" width="80" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.callCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="失败调用" width="90" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatNumber(row.callFailCount || 0) }}</template>
        </el-table-column>
        <el-table-column prop="lastLoginAt" label="最后登录" width="170" class-name="hide-on-mobile" />
        <el-table-column label="操作" width="100" class-name="hide-on-mobile">
          <template #default="{ row }">
            <button class="linkish" type="button" @click="go(`/llm-call?userId=${row.userId}`)">调用流水</button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { formatNumber, rankBarOption, type RankItem } from '../chart-options'
import type { UsersPayload } from '../types'

const props = defineProps<{ payload: UsersPayload | null; loading?: boolean; error?: boolean }>()
const router = useRouter()

const userRows = computed(() => props.payload?.userActivity || [])

const messageItems = computed<RankItem[]>(() =>
  userRows.value
    .map((row) => ({
      name: row.displayName || row.username || '未知',
      value: Number(row.messageCount || 0)
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
)

const tokenItems = computed<RankItem[]>(() =>
  userRows.value
    .map((row) => ({
      name: row.displayName || row.username || '未知',
      value: Number(row.totalTokens || 0)
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
)

function go(path: string) {
  router.push(path)
}
</script>

<script lang="ts">
export default { name: 'UserTab' }
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.linkish {
  padding: 0;
  border: none;
  background: none;
  color: var(--mao-accent);
  font: inherit;
  cursor: pointer;
}

.linkish:hover {
  text-decoration: underline;
}
</style>
