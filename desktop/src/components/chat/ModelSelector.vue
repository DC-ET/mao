<template>
  <el-popover ref="popoverRef" trigger="click" :width="280" placement="top-end" @before-enter="loadModels">
    <template #reference>
      <span class="model-name clickable" :class="{ compact }" :title="displayName || '选择模型'">
        {{ label }}
      </span>
    </template>
    <div class="model-selector">
      <div v-if="loadingModels" class="model-loading">加载中...</div>
      <template v-else>
        <!-- 当前模型不在可见列表（历史会话沿用隐藏模型，或 Agent 默认模型是隐藏模型）：
             只读展示，避免用户看到「下拉里没有自己正在用的模型」。技术方案 2026-11-24 §8.1。 -->
        <div v-if="currentModelOutsideList" class="model-option current readonly">
          <div class="model-option-info">
            <span class="model-option-name">{{ displayName }}</span>
          </div>
          <el-tag size="small" type="warning">仅管理端</el-tag>
        </div>
        <div
          v-for="m in models"
          :key="m.id"
          class="model-option"
          :class="{ active: m.id === modelId }"
          @click.stop="handleSelect(m.id)"
        >
          <div class="model-option-info">
            <span class="model-option-name">{{ m.name }}</span>
          </div>
          <el-tag v-if="m.supportsVision" size="small" type="success">视觉</el-tag>
        </div>
        <div v-if="models.length === 0" class="model-empty">暂无可用模型</div>
      </template>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { ref, computed, toRef } from 'vue'
import { api } from '../../api'
import { useModelName } from '../../composables/useModelName'

interface ModelItem {
  id: number
  name: string
  modelId: string
  supportsVision: boolean
  isDefault: boolean
}

const props = defineProps<{
  modelId?: number
  /** 窄屏紧凑展示：超长模型名截断，未选中显示「模型」 */
  compact?: boolean
}>()

const emit = defineEmits<{
  'update:modelId': [modelId: number]
  select: [modelId: number, modelIdStr: string]
}>()

const popoverRef = ref()
const models = ref<ModelItem[]>([])
const loadingModels = ref(true)
/** 本组件至少成功拉过一次列表：失败时不要用空列表推断「当前模型仅管理端」。 */
const loadedOk = ref(false)

// Use composable to resolve model name from ID
const modelIdRef = toRef(props, 'modelId')
const { modelName: displayName } = useModelName(modelIdRef)

/** 当前模型不在候选列表：只在加载完成后判断，避免请求期间闪一条假「仅管理端」。 */
const currentModelOutsideList = computed(() => {
  if (!loadedOk.value || loadingModels.value || props.modelId == null) return false
  return !models.value.some(m => m.id === props.modelId)
})

const label = computed(() => {
  const name = displayName.value || ''
  // 超长模型名交给 CSS 省略号按实际可用宽度截断（title 保留全名），
  // 不再按固定字数硬切，避免工具条还有空间却只剩几个字符
  if (!name) return props.compact ? '模型' : '选择模型'
  return name
})

async function loadModels() {
  loadingModels.value = true
  try {
    // scope=client：只列客户端可选模型（技术方案 2026-11-24 §8.1）。
    // 不带 scope 的全量列表留给管理后台（Agent 默认模型/机器人配置）。
    const { data } = await api.get('/models/active', { params: { scope: 'client' } })
    models.value = data || []
    loadedOk.value = true
  } catch {
    // 失败保持 loadedOk=false：宁可只显示真实候选，也不误标「仅管理端」
    loadedOk.value = false
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

.model-name.compact {
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: var(--aw-primary-hover);
}

.model-option.current.readonly {
  cursor: default;
  opacity: 0.85;
}

.model-option.current.readonly:hover {
  background: transparent;
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
