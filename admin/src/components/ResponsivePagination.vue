<template>
  <el-pagination
    :current-page="currentPage"
    :page-size="pageSize"
    :total="total"
    :page-sizes="pageSizes"
    :layout="isMobile ? 'prev, pager, next' : layout"
    :small="isMobile"
    v-bind="$attrs"
    @current-change="handleCurrentChange"
    @size-change="handleSizeChange"
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
  (e: 'current-change', value: number): void
  (e: 'size-change', value: number): void
}>()

function handleCurrentChange(page: number) {
  emit('update:currentPage', page)
  emit('current-change', page)
}

function handleSizeChange(size: number) {
  emit('update:pageSize', size)
  emit('size-change', size)
}

const { isMobile } = useBreakpoint()

// Mobile defaults to 10 per page to keep cards short.
const currentPage = computed(() => props.currentPage)
const pageSize = computed(() => props.pageSize)
const total = computed(() => props.total)
const pageSizes = computed(() => props.pageSizes)
const layout = computed(() => props.layout)
</script>
