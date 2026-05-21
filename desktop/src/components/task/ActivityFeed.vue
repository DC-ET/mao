<template>
  <div v-if="activities.length > 0" class="activity-feed">
    <ActivityLine
      v-for="activity in activities"
      :key="activity.id || activity.summary"
      :activity="activity"
    />
  </div>
</template>

<script setup lang="ts">
import ActivityLine from './ActivityLine.vue'

defineProps<{
  activities: Array<{
    id?: number
    type: string
    target?: string
    summary: string
    status?: string
    durationMs?: number
  }>
}>()
</script>

<style scoped>
.activity-feed {
  padding: 4px 0 8px;
  border-left: 2px solid var(--aw-divider-soft);
  margin: 4px 0 4px 16px;
  padding-left: 12px;
}
</style>
