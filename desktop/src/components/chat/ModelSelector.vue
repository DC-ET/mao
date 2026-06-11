<template>
  <el-popover ref="popoverRef" trigger="click" :width="280" placement="top-end" @before-enter="loadModels">
    <template #reference>
      <span class="model-name clickable">{{ modelIdStr || '选择模型' }}</span>
    </template>
    <div class="model-selector">
      <div v-if="loadingModels" class="model-loading">加载中...</div>
      <template v-else>
        <div
          v-for="m in models"
          :key="m.id"
          class="model-option"
          :class="{ active: m.id === modelId }"
          @click.stop="handleSelect(m.id)"
        >
          <div class="model-option-info">
            <span class="model-option-name">{{ m.modelId }}</span>
          </div>
          <el-tag v-if="m.supportsVision" size="small" type="success">视觉</el-tag>
        </div>
        <div v-if="models.length === 0" class="model-empty">暂无可用模型</div>
      </template>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../../api'

interface ModelItem {
  id: number
  name: string
  modelId: string
  supportsVision: boolean
  isDefault: boolean
}

defineProps<{
  modelId?: number
  modelIdStr?: string
}>()

const emit = defineEmits<{
  'update:modelId': [modelId: number]
  select: [modelId: number, modelIdStr: string]
}>()

const popoverRef = ref()
const models = ref<ModelItem[]>([])
const loadingModels = ref(false)

async function loadModels() {
  if (models.value.length > 0) return
  loadingModels.value = true
  try {
    const { data } = await api.get('/models/active')
    models.value = data || []
  } catch {
    // ignore
  } finally {
    loadingModels.value = false
  }
}

function handleSelect(id: number) {
  emit('update:modelId', id)
  const model = models.value.find(m => m.id === id)
  if (model) emit('select', id, model.modelId)
  popoverRef.value?.hide()
}
</script>

<style scoped>
.model-name {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
  user-select: none;
}

.model-name.clickable {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
  transition: background 0.15s;
}

.model-name.clickable:hover {
  background: var(--aw-canvas-parchment);
}

.model-selector {
  max-height: 300px;
  overflow-y: auto;
}

.model-loading,
.model-empty {
  text-align: center;
  padding: 12px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}

.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: background 0.15s;
}

.model-option:hover {
  background: var(--aw-canvas-parchment);
}

.model-option.active {
  background: rgba(0, 102, 204, 0.08);
}

.model-option-info {
  display: flex;
  align-items: center;
  gap: 6px;
}

.model-option-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-body);
}
</style>
