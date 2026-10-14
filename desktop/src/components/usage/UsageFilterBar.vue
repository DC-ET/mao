<template>
  <el-form :inline="true" size="small" class="usage-filter-bar">
    <el-form-item label="场景">
      <el-select v-model="sceneModel" clearable placeholder="全部" style="width: 120px">
        <el-option v-for="opt in LLM_CALL_SCENE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="模型">
      <el-select
        v-model="modelModel"
        clearable
        filterable
        placeholder="全部"
        :loading="loadingModels"
        style="width: 160px"
      >
        <el-option v-for="m in models" :key="m.id" :label="m.name" :value="m.id" />
      </el-select>
    </el-form-item>
    <el-form-item label="结果">
      <el-select v-model="resultModel" clearable placeholder="全部" style="width: 100px">
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
        <el-option label="取消" value="cancelled" />
      </el-select>
    </el-form-item>
    <el-form-item>
      <el-button type="primary" size="small" @click="emit('search')">查询</el-button>
      <el-button size="small" @click="handleReset">重置</el-button>
    </el-form-item>
  </el-form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { LLM_CALL_SCENE_OPTIONS } from '../../utils/llmCallLabels'
import { EMPTY_USAGE_FILTERS, type UsageFilters } from './types'

const props = defineProps<{ modelValue: UsageFilters }>()

const emit = defineEmits<{
  'update:modelValue': [value: UsageFilters]
  search: []
}>()

interface ModelOption {
  id: number
  name: string
}

const models = ref<ModelOption[]>([])
const loadingModels = ref(false)

// 模型选项与聊天区 ModelSelector 同源（/models/active，仅启用中的模型）。
// 历史调用里已停用/删除的模型不在列表中，对应明细行仍按记录快照的模型名展示。
onMounted(async () => {
  loadingModels.value = true
  try {
    const { data } = await api.get('/models/active')
    models.value = (data ?? []).map((m: ModelOption) => ({ id: m.id, name: m.name }))
  } catch {
    models.value = []
  } finally {
    loadingModels.value = false
  }
})

/** 任一筛选项变化即合并出新 filters 并触发查询（沿用设置页既有交互：改条件即查）。 */
function patch(next: Partial<UsageFilters>) {
  emit('update:modelValue', { ...props.modelValue, ...next })
  emit('search')
}

const sceneModel = computed({
  get: () => props.modelValue.scene,
  set: (v: string) => patch({ scene: v ?? '' }),
})

const modelModel = computed({
  get: () => props.modelValue.modelId,
  set: (v: number | undefined) => patch({ modelId: v ?? undefined }),
})

/**
 * 结果四态下拉（全部 / 成功 / 失败 / 取消）↔ (success, cancelled) 的映射：
 * 「失败」是纯失败，用户点停止的取消单列一档，与调用流水同口径。
 */
const resultModel = computed<'success' | 'failed' | 'cancelled' | undefined>({
  get: () => {
    if (props.modelValue.cancelled) return 'cancelled'
    if (props.modelValue.success === true) return 'success'
    if (props.modelValue.success === false) return 'failed'
    return undefined
  },
  set: (v) => patch({
    success: v === 'success' ? true : v === 'failed' ? false : undefined,
    cancelled: v === 'cancelled' ? true : undefined,
  }),
})

function handleReset() {
  emit('update:modelValue', { ...EMPTY_USAGE_FILTERS })
  emit('search')
}
</script>
<style scoped>
.usage-filter-bar {
  margin-bottom: 16px;
}
</style>
