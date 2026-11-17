<template>
  <div class="docs-nav">
    <div class="docs-nav__search">
      <el-input v-model="keyword" placeholder="筛选文档" clearable size="small" />
    </div>
    <p v-if="!filteredGroups.length" class="docs-nav__empty">没有匹配的文档</p>
    <section v-for="group in filteredGroups" :key="group.title" class="docs-nav__group">
      <h4 class="docs-nav__group-title">{{ group.title }}</h4>
      <a
        v-for="doc in group.items"
        :key="doc.slug"
        class="docs-nav__item"
        :class="{ 'docs-nav__item--active': doc.slug === activeSlug }"
        :href="`/docs/${doc.slug}`"
        @click.prevent="$emit('navigate', doc.slug)"
      >{{ doc.title }}</a>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DocsNavGroup } from './docsCatalog'

const props = defineProps<{
  groups: DocsNavGroup[]
  activeSlug?: string
}>()

defineEmits<{ navigate: [slug: string] }>()

const keyword = ref('')

const filteredGroups = computed<DocsNavGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return props.groups
  return props.groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter(
        (doc) =>
          doc.title.toLowerCase().includes(kw) || doc.slug.toLowerCase().includes(kw)
      )
    }))
    .filter((group) => group.items.length > 0)
})
</script>

<style scoped>
.docs-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.docs-nav__search {
  padding: 0 4px 10px;
}
.docs-nav__empty {
  margin: 8px 4px;
  font-size: 13px;
  color: var(--aw-ink-muted);
}
.docs-nav__group {
  margin-bottom: 14px;
}
.docs-nav__group-title {
  margin: 0 0 6px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--aw-ink-muted);
}
.docs-nav__item {
  display: block;
  padding: 6px 8px;
  border-radius: var(--aw-radius-sm);
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--aw-ink-muted-64);
  text-decoration: none;
  transition: color 0.12s ease, background 0.12s ease;
}
.docs-nav__item:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}
.docs-nav__item--active {
  color: var(--aw-primary);
  background: var(--aw-primary-soft);
  font-weight: 500;
}
</style>
