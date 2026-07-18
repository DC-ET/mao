<template>
  <el-pagination
    :current-page="currentPage"
    :page-size="pageSize"
    :total="total"
    :page-sizes="pageSizes"
    :layout="isMobile ? 'prev, pager, next' : layout"
    :small="isMobile"
    v-bind="$attrs"
    @current-change="(p: number) => emit('update:currentPage', p)"
    @size-change="(s: number) => emit('update:pageSize', s)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useBreakpoint } from '../composables/useBreakpoint'

const props = withDefaults(
  defineProps<{
    currentPage: number
    pageSize: number
    total: number
    pageSizes?: number[]
    layout?: string
  }>(),
  {
    pageSizes: () => [10, 20, 50, 100],
    layout: 'total, sizes, prev, pager, next, jumper'
  }
)

const emit = defineEmits<{
  (e: 'update:currentPage', value: number): void
  (e: 'update:pageSize', value: number): void
}>()

const { isMobile } = useBreakpoint()

// Mobile defaults to 10 per page to keep cards short.
const currentPage = computed(() => props.currentPage)
const pageSize = computed(() => props.pageSize)
const total = computed(() => props.total)
const pageSizes = computed(() => props.pageSizes)
const layout = computed(() => props.layout)
</script>
