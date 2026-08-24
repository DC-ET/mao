<template>
  <div class="filter-panel">
    <div class="filter-always">
      <slot name="always" />
      <el-button
        v-if="isMobile && hasExtra"
        text
        type="primary"
        class="filter-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起筛选' : '更多筛选' }}
      </el-button>
    </div>
    <div v-show="!isMobile || expanded" class="filter-extra">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from 'vue'
import { useBreakpoint } from '../composables/useBreakpoint'

const { isMobile } = useBreakpoint()
const slots = useSlots()
const expanded = ref(false)
const hasExtra = computed(() => Boolean(slots.default))
</script>

<style scoped>
.filter-always {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0;
}

.filter-toggle {
  margin-bottom: 12px;
}

@media (max-width: 768px) {
  .filter-always {
    flex-direction: column;
  }

  .filter-toggle {
    align-self: flex-start;
    min-height: 36px;
    margin-bottom: 8px;
  }
}
</style>
