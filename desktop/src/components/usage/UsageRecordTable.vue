<template>
  <el-table :data="records" v-loading="loading" stripe size="small">
    <template #empty>
      <el-empty description="暂无调用记录" :image-size="48" />
    </template>
    <el-table-column label="时间" width="140">
      <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
    </el-table-column>
    <el-table-column label="场景" width="72">
      <template #default="{ row }">{{ llmCallSceneLabel(row.scene) }}</template>
    </el-table-column>
    <el-table-column label="模型" min-width="100" show-overflow-tooltip>
      <template #default="{ row }">{{ row.modelName || row.providerModelId || '-' }}</template>
    </el-table-column>
    <el-table-column label="入 Token" width="88" align="right">
      <template #default="{ row }">{{ formatToken(row.promptTokens || 0) }}</template>
    </el-table-column>
    <el-table-column label="缓存" width="118" align="right">
      <template #default="{ row }">{{ formatCacheHit(row) }}</template>
    </el-table-column>
    <el-table-column label="出 Token" width="88" align="right">
      <template #default="{ row }">{{ formatToken(row.completionTokens || 0) }}</template>
    </el-table-column>
    <el-table-column label="首字" width="72" align="right">
      <template #default="{ row }">{{ formatMs(row.firstTokenMs) }}</template>
    </el-table-column>
    <el-table-column label="耗时" width="72" align="right">
      <template #default="{ row }">{{ formatMs(row.durationMs) }}</template>
    </el-table-column>
    <el-table-column label="吞吐" width="84" align="right">
      <template #default="{ row }">{{ formatThroughput(row) }}</template>
    </el-table-column>
    <el-table-column label="结果" width="64">
      <template #default="{ row }">
        <el-tag size="small" :type="callResultTag(row).type">{{ callResultTag(row).label }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="会话" width="64">
      <template #default="{ row }">
        <el-button v-if="row.sessionId" type="primary" link size="small" @click="emit('go-session', row.sessionId)">
          #{{ row.sessionId }}
        </el-button>
        <span v-else>-</span>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import type { MyLlmCallRecord } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { formatCacheHit, formatToken } from '../../utils/usageFormat'
import { formatMs, llmCallSceneLabel } from '../../utils/llmCallLabels'
import { formatThroughput } from '../../utils/throughput'
import { callResultTag } from './result-tag'

defineProps<{
  records: MyLlmCallRecord[]
  loading?: boolean
}>()

const emit = defineEmits<{
  'go-session': [sessionId: number]
}>()
</script>
