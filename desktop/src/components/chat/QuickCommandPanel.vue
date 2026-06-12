<template>
  <div v-if="visible" class="quick-command-panel" @mousedown.prevent>
    <div v-if="filteredItems.length === 0" class="panel-empty">
      未找到匹配的指令
    </div>
    <template v-else>
      <div v-if="filteredSkills.length > 0" class="panel-group">
        <div class="group-label">Skills</div>
        <div
          v-for="(item, idx) in filteredSkills"
          :key="'skill-' + item.name"
          class="panel-item"
          :class="{ active: selectedIndex === getGlobalIndex('skill', idx) }"
          @mouseenter="selectedIndex = getGlobalIndex('skill', idx)"
          @click="selectItem(item)"
        >
          <span class="item-name">{{ item.name }}</span>
          <span v-if="item.description" class="item-desc">{{ item.description }}</span>
        </div>
      </div>
      <div v-if="filteredCommands.length > 0" class="panel-group">
        <div class="group-label">Commands</div>
        <div
          v-for="(item, idx) in filteredCommands"
          :key="'command-' + item.name"
          class="panel-item"
          :class="{ active: selectedIndex === getGlobalIndex('command', idx) }"
          @mouseenter="selectedIndex = getGlobalIndex('command', idx)"
          @click="selectItem(item)"
        >
          <span class="item-name">{{ item.name }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { QuickCommand } from '../../types/quick-command'

const props = defineProps<{
  visible: boolean
  skills: QuickCommand[]
  commands: QuickCommand[]
  filter: string
}>()

const emit = defineEmits<{
  select: [item: QuickCommand]
  close: []
}>()

const selectedIndex = ref(0)

const filteredSkills = computed(() => {
  if (!props.filter) return props.skills
  const q = props.filter.toLowerCase()
  return props.skills.filter(s => s.name.toLowerCase().startsWith(q))
})

const filteredCommands = computed(() => {
  if (!props.filter) return props.commands
  const q = props.filter.toLowerCase()
  return props.commands.filter(c => c.name.toLowerCase().startsWith(q))
})

const filteredItems = computed(() => [...filteredSkills.value, ...filteredCommands.value])

function getGlobalIndex(group: 'skill' | 'command', localIndex: number): number {
  if (group === 'skill') return localIndex
  return filteredSkills.value.length + localIndex
}

watch(() => props.visible, (val) => {
  if (val) selectedIndex.value = 0
})

watch(() => props.filter, () => {
  selectedIndex.value = 0
})

function selectItem(item: QuickCommand) {
  emit('select', item)
}

function moveUp() {
  if (filteredItems.value.length === 0) return
  selectedIndex.value = (selectedIndex.value - 1 + filteredItems.value.length) % filteredItems.value.length
  scrollToSelected()
}

function moveDown() {
  if (filteredItems.value.length === 0) return
  selectedIndex.value = (selectedIndex.value + 1) % filteredItems.value.length
  scrollToSelected()
}

function confirmSelection() {
  if (filteredItems.value.length === 0) return
  const item = filteredItems.value[selectedIndex.value]
  if (item) selectItem(item)
}

function scrollToSelected() {
  nextTick(() => {
    const panel = document.querySelector('.quick-command-panel')
    const active = panel?.querySelector('.panel-item.active')
    if (active) {
      active.scrollIntoView({ block: 'nearest' })
    }
  })
}

defineExpose({ moveUp, moveDown, confirmSelection })
</script>

<style scoped>
.quick-command-panel {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
  z-index: 100;
  margin-bottom: 4px;
}

[data-theme="dark"] .quick-command-panel {
  background: var(--aw-canvas-parchment);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
}

.panel-empty {
  padding: 16px;
  text-align: center;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.panel-group {
  padding: 4px 0;
}

.panel-group + .panel-group {
  border-top: 1px solid var(--aw-divider-soft);
}

.group-label {
  padding: 6px 14px 2px;
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink-muted-48);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.panel-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.1s;
  border-radius: 4px;
  margin: 0 4px;
}

.panel-item:hover,
.panel-item.active {
  background: var(--aw-canvas-parchment);
}

[data-theme="dark"] .panel-item:hover,
[data-theme="dark"] .panel-item.active {
  background: rgba(255, 255, 255, 0.06);
}

.item-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink);
  flex-shrink: 0;
}

.item-desc {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
