<template>
  <div class="docs-page">
    <header class="dt-bar">
      <a class="dt-bar__brand" href="/welcome" @click.prevent="router.push('/welcome')">
        <img :src="appIcon" alt="" class="dt-bar__logo" />
        <span class="dt-bar__name">Mao</span>
      </a>
      <span class="dt-bar__divider" aria-hidden="true" />
      <span class="dt-bar__title">官方文档</span>
      <span class="dt-bar__spacer" />
      <a
        class="dt-bar__link"
        href="https://github.com/DC-ET/mao"
        target="_blank"
        rel="noopener noreferrer"
      >GitHub</a>
      <button
        class="dt-bar__menu"
        type="button"
        aria-label="文档目录"
        title="文档目录"
        @click="drawerVisible = true"
      >
        <el-icon :size="18"><List /></el-icon>
      </button>
    </header>

    <div class="dt-layout">
      <aside class="dt-side">
        <DocsNav
          :groups="navGroups"
          :active-slug="currentSlug"
          @navigate="goDoc"
        />
      </aside>

      <main ref="mainRef" class="dt-main" @click.capture="onContentClick">
        <template v-if="currentDoc">
          <div class="dt-head">
            <p class="dt-head__crumb">
              <a href="/docs" @click.prevent="goDoc('')">官方文档</a>
              <span aria-hidden="true">/</span>
              <span>{{ currentGroupTitle }}</span>
            </p>
            <h1 class="dt-head__title">{{ currentDoc.title }}</h1>
            <a class="dt-head__source" :href="GITHUB_BLOB_BASE + currentDoc.sourcePath" target="_blank" rel="noopener noreferrer">
              在 GitHub 上查看源文件
            </a>
          </div>
          <MarkdownContent
            :key="currentDoc.slug"
            :content="currentDoc.body"
            body-class="markdown-body dt-markdown"
          />
        </template>

        <!-- 文档总览（/docs） -->
        <template v-else>
          <div class="dt-home">
            <h1 class="dt-home__title">Mao 官方文档</h1>
            <p class="dt-home__lead">
              团队级 AI Agent 自托管平台的产品说明、部署配置、全端使用手册与排障指南。
              文档正文与仓库内 <code>skills/mao-cli/</code> 同源，随版本持续更新。
            </p>
            <p v-if="unknownSlug" class="dt-home__notice">
              未找到文档「{{ unknownSlug }}」，以下为全部文档目录。
            </p>
            <section v-for="group in navGroups" :key="group.title" class="dt-home__group">
              <h2 class="dt-home__group-title">{{ group.title }}</h2>
              <div class="dt-home__cards">
                <a
                  v-for="doc in group.items"
                  :key="doc.slug"
                  class="dt-home__card"
                  :href="`/docs/${doc.slug}`"
                  @click.prevent="goDoc(doc.slug)"
                >
                  <span class="dt-home__card-title">{{ doc.title }}</span>
                  <span class="dt-home__card-slug">{{ doc.slug }}.md</span>
                </a>
              </div>
            </section>
          </div>
        </template>
      </main>

      <nav v-if="toc.length" class="dt-toc" aria-label="本页目录">
        <p class="dt-toc__title">本页目录</p>
        <a
          v-for="item in toc"
          :key="item.id"
          class="dt-toc__item"
          :class="{ 'dt-toc__item--h3': item.level === 3 }"
          :href="`#${item.id}`"
          @click.prevent="scrollToHeading(item.id)"
        >{{ item.text }}</a>
      </nav>
    </div>

    <el-drawer
      v-model="drawerVisible"
      direction="ltr"
      size="78%"
      :with-header="false"
      class="dt-drawer"
    >
      <DocsNav
        :groups="navGroups"
        :active-slug="currentSlug"
        @navigate="goDoc($event, true)"
      />
    </el-drawer>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { List } from '@element-plus/icons-vue'
import MarkdownContent from '../../components/common/MarkdownContent.vue'
import DocsNav from './DocsNav.vue'
import { docGroups } from './docsCatalog'
import type { DocsNavGroup } from './docsCatalog'
import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'
import { openExternalUrl } from '../../utils/capacitor'
import appIcon from '../../assets/app-icon-small.png'
import businessProcessRaw from '../../../../skills/mao-cli/business_process.md?raw'

// ---- 文档载入：正文唯一来源是仓库 skills/mao-cli/ 的 markdown，构建期 ?raw 打包，不做冗余复制 ----
interface DocEntry {
  slug: string
  title: string
  body: string
  sourcePath: string
}

const rawModules = import.meta.glob('../../../../skills/mao-cli/reference/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

function splitTitle(raw: string): { title: string; body: string } {
  const m = raw.match(/^#\s+(.+)\n([\s\S]*)$/)
  return m ? { title: m[1].trim(), body: m[2] } : { title: '未命名文档', body: raw }
}

const docsMap: Record<string, DocEntry> = {}
for (const [path, raw] of Object.entries(rawModules)) {
  const slug = (path.split('/').pop() || '').replace(/\.md$/, '')
  const { title, body } = splitTitle(raw)
  docsMap[slug] = { slug, title, body, sourcePath: `skills/mao-cli/reference/${slug}.md` }
}
docsMap['business_process'] = {
  slug: 'business_process',
  ...splitTitle(businessProcessRaw),
  sourcePath: 'skills/mao-cli/business_process.md'
}

const route = useRoute()
const router = useRouter()

const GITHUB_BLOB_BASE = 'https://github.com/DC-ET/mao/blob/main/'

const navGroups = computed<DocsNavGroup[]>(() => {
  const used = new Set<string>()
  const groups: DocsNavGroup[] = []
  for (const group of docGroups) {
    const items = group.slugs
      .filter((slug) => docsMap[slug])
      .map((slug) => {
        used.add(slug)
        return { slug, title: docsMap[slug].title }
      })
    if (items.length) groups.push({ title: group.title, items })
  }
  const rest = Object.keys(docsMap)
    .filter((slug) => !used.has(slug))
    .sort()
    .map((slug) => ({ slug, title: docsMap[slug].title }))
  if (rest.length) groups.push({ title: '其他', items: rest })
  return groups
})

const currentSlug = computed(() => {
  const param = route.params.slug
  return typeof param === 'string' ? param : ''
})
const currentDoc = computed(() => (currentSlug.value ? (docsMap[currentSlug.value] ?? null) : null))
const unknownSlug = computed(() => (currentSlug.value && !currentDoc.value ? currentSlug.value : ''))
const currentGroupTitle = computed(() => {
  for (const group of navGroups.value) {
    if (group.items.some((doc) => doc.slug === currentSlug.value)) return group.title
  }
  return ''
})

const drawerVisible = ref(false)

function goDoc(slug: string, fromDrawer = false) {
  if (fromDrawer) drawerVisible.value = false
  router.push(slug ? `/docs/${slug}` : '/docs')
}

// ---- 标题锚点与本页目录 ----
interface TocItem {
  level: number
  id: string
  text: string
}

const toc = ref<TocItem[]>([])
const mainRef = ref<HTMLElement | null>(null)
let pendingAnchor = ''

function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '')
}

/** 文档内既有锚点是 Gitee/GitHub 风格 slug（如「公司-ssoweb-web-embed-sdk」），与标题做去符号归一匹配 */
function normAnchor(s: string): string {
  return s.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
}

function findHeadingEl(root: Element, anchor: string): HTMLElement | null {
  try {
    const direct = root.querySelector('#' + CSS.escape(anchor))
    if (direct) return direct as HTMLElement
  } catch {
    // 非法选择器时走文本归一匹配
  }
  let target = anchor
  try {
    target = decodeURIComponent(anchor)
  } catch {
    // 保留原文
  }
  const norm = normAnchor(target)
  if (!norm) return null
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4'))
  const textOf = (el: Element) => normAnchor(el.textContent || '')
  const exact = headings.find((h) => textOf(h) === norm)
  if (exact) return exact as HTMLElement
  const loose = headings.find((h) => {
    const text = textOf(h)
    return text.startsWith(norm) || norm.startsWith(text)
  })
  return loose ? (loose as HTMLElement) : null
}

function enhance() {
  const root = mainRef.value?.querySelector('.dt-markdown')
  if (!root) return
  const used = new Map<string, number>()
  const items: TocItem[] = []
  for (const h of Array.from(root.querySelectorAll('h2, h3'))) {
    const text = (h.textContent || '').trim()
    if (!text) continue
    const baseId = slugifyHeading(text) || 'section'
    const count = used.get(baseId) ?? 0
    used.set(baseId, count + 1)
    const id = count ? `${baseId}-${count}` : baseId
    ;(h as HTMLElement).id = id
    items.push({ level: h.tagName === 'H2' ? 2 : 3, id, text })
  }
  toc.value = items
  if (pendingAnchor) {
    const el = findHeadingEl(root, pendingAnchor)
    pendingAnchor = ''
    if (el) el.scrollIntoView({ block: 'start' })
  }
}

let observer: MutationObserver | null = null
let enhanceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleEnhance() {
  if (enhanceTimer) clearTimeout(enhanceTimer)
  enhanceTimer = setTimeout(() => {
    enhanceTimer = null
    enhance()
  }, 80)
}

function ensureObserver() {
  if (observer) return
  const host = mainRef.value
  if (!host || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(scheduleEnhance)
  observer.observe(host, { childList: true, subtree: true })
}

function scrollToHeading(anchor: string) {
  const root = mainRef.value?.querySelector('.dt-markdown')
  if (!root) return
  const el = findHeadingEl(root, anchor)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---- 站内相对链接（文档互链 / 锚点）拦截；外链交给 document 级委托 ----
function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const anchor = target?.closest?.('a') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!href) return
  if (isExternalMarkdownLink(href)) return

  e.preventDefault()
  const hashIdx = href.indexOf('#')
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''
  if (!pathPart) {
    if (fragment) scrollToHeading(fragment)
    return
  }
  const resolved = resolveMarkdownLink(currentDoc.value?.sourcePath ?? 'skills/mao-cli', href)
  if (!resolved) return
  const match = resolved.match(/([^/]+)\.md$/)
  const slug = match?.[1] ?? ''
  if (slug && docsMap[slug]) {
    router.push({ path: `/docs/${slug}`, hash: fragment ? `#${encodeURIComponent(fragment)}` : '' })
    return
  }
  // 不在文档集里的相对文件（脚本、配置样例等）→ 打开 GitHub 源文件
  void openExternalUrl(`https://github.com/DC-ET/mao/blob/main/${resolved}`)
}

watch(currentSlug, () => {
  toc.value = []
  if (!route.hash) window.scrollTo({ top: 0 })
})

watch(
  () => route.hash,
  (hash) => {
    pendingAnchor = hash ? hash.replace(/^#/, '') : ''
    if (pendingAnchor) scheduleEnhance()
  },
  { immediate: true }
)

const previousTitle = document.title
watch(
  currentDoc,
  (doc) => {
    document.title = doc ? `${doc.title} · Mao 官方文档` : 'Mao 官方文档'
  },
  { immediate: true }
)

onMounted(() => {
  ensureObserver()
  scheduleEnhance()
})

onBeforeUnmount(() => {
  document.title = previousTitle
  observer?.disconnect()
  observer = null
  if (enhanceTimer) clearTimeout(enhanceTimer)
})
</script>

<style scoped>
.docs-page {
  min-height: 100vh;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-family: var(--aw-font-text);
  -webkit-font-smoothing: antialiased;
}

/* ---------- 顶栏 ---------- */
.dt-bar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  padding: 0 20px;
  background: var(--aw-surface-glass);
  backdrop-filter: saturate(180%) blur(18px);
  -webkit-backdrop-filter: saturate(180%) blur(18px);
  border-bottom: 1px solid var(--aw-divider);
}
.dt-bar__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  text-decoration: none;
  color: var(--aw-ink);
}
.dt-bar__logo {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}
.dt-bar__name {
  font-family: var(--aw-font-display);
  font-size: 17px;
  font-weight: 600;
}
.dt-bar__divider {
  width: 1px;
  height: 18px;
  background: var(--aw-divider);
}
.dt-bar__title {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--aw-ink-muted-64);
}
.dt-bar__spacer {
  flex: 1;
}
.dt-bar__link {
  font-size: 13.5px;
  color: var(--aw-ink-muted-64);
  text-decoration: none;
}
.dt-bar__link:hover {
  color: var(--aw-ink);
}
.dt-bar__menu {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-ink);
  cursor: pointer;
}
.dt-bar__menu:hover {
  background: var(--aw-surface-hover);
}

/* ---------- 布局 ---------- */
.dt-layout {
  display: grid;
  grid-template-columns: 252px minmax(0, 1fr) 216px;
  gap: 32px;
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
  align-items: start;
}
.dt-side {
  position: sticky;
  top: 56px;
  max-height: calc(100vh - 56px);
  overflow-y: auto;
  padding: 22px 0 32px;
}
.dt-main {
  min-width: 0;
  padding: 22px 0 72px;
}

/* ---------- 文档头 ---------- */
.dt-head {
  margin-bottom: 26px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--aw-divider-soft);
}
.dt-head__crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--aw-ink-muted);
}
.dt-head__crumb a {
  color: var(--aw-ink-muted-64);
  text-decoration: none;
}
.dt-head__crumb a:hover {
  color: var(--aw-primary);
}
.dt-head__title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--aw-ink);
}
.dt-head__source {
  display: inline-block;
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--aw-ink-muted);
  text-decoration: none;
}
.dt-head__source:hover {
  color: var(--aw-primary);
}

/* ---------- 正文排版（与 FileViewer 的 .markdown-body 同一套字号节奏） ---------- */
.dt-markdown {
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
}
.dt-markdown :deep(h1),
.dt-markdown :deep(h2),
.dt-markdown :deep(h3),
.dt-markdown :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 26px 0 10px;
  letter-spacing: var(--aw-tracking);
  scroll-margin-top: 76px;
}
.dt-markdown :deep(h2) {
  font-size: var(--aw-text-lead-airy);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--aw-divider-soft);
}
.dt-markdown :deep(h3) { font-size: var(--aw-text-tagline); }
.dt-markdown :deep(h4) { font-size: var(--aw-text-body); }
.dt-markdown :deep(p) {
  margin: 10px 0;
  font-size: 15px;
  line-height: 1.95;
  letter-spacing: var(--aw-tracking);
}
.dt-markdown :deep(a) {
  color: var(--aw-primary);
  text-decoration: none;
}
.dt-markdown :deep(a:hover) { text-decoration: underline; }
.dt-markdown :deep(strong) { font-weight: 600; }
.dt-markdown :deep(code) {
  font-family: var(--aw-font-mono);
  font-size: 13px;
}
.dt-markdown :deep(pre) {
  margin: 10px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}
.dt-markdown :deep(.code-block) {
  margin: 12px 0;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}
.dt-markdown :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--aw-surface-code-header);
  border-bottom: 1px solid var(--aw-divider-soft);
  font-size: var(--aw-text-fine);
}
.dt-markdown :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--aw-tracking);
}
.dt-markdown :deep(.code-copy-btn) {
  background: none;
  border: 1px solid var(--aw-hairline);
  color: var(--aw-ink-muted-48);
  padding: 2px 10px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}
.dt-markdown :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}
.dt-markdown :deep(.monaco-code) {
  display: block;
  padding: 12px;
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
  font-family: var(--aw-font-mono);
  font-size: 13px;
  line-height: 20px;
}
.dt-markdown :deep(ul),
.dt-markdown :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}
.dt-markdown :deep(li) {
  font-size: 15px;
  line-height: 1.95;
  letter-spacing: var(--aw-tracking);
}
.dt-markdown :deep(blockquote) {
  margin: 12px 0;
  padding: 6px 14px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}
.dt-markdown :deep(table) {
  border-collapse: collapse;
  margin: 12px 0;
  width: 100%;
}
.dt-markdown :deep(th),
.dt-markdown :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 7px 12px;
  text-align: left;
  font-size: 13.5px;
  line-height: 1.7;
}
.dt-markdown :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}
.dt-markdown :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 20px 0;
}

/* ---------- 本页目录 ---------- */
.dt-toc {
  position: sticky;
  top: 56px;
  max-height: calc(100vh - 56px);
  overflow-y: auto;
  padding: 30px 0 32px;
}
.dt-toc__title {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--aw-ink-muted);
}
.dt-toc__item {
  display: block;
  padding: 4px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--aw-ink-muted-64);
  text-decoration: none;
  border-left: 2px solid var(--aw-divider-soft);
  padding-left: 10px;
}
.dt-toc__item:hover {
  color: var(--aw-ink);
}
.dt-toc__item--h3 {
  padding-left: 22px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

/* ---------- 文档总览（/docs） ---------- */
.dt-home__title {
  margin: 8px 0 0;
  font-family: var(--aw-font-display);
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -0.015em;
}
.dt-home__lead {
  margin: 14px 0 0;
  max-width: 640px;
  font-size: 15.5px;
  line-height: 1.9;
  color: var(--aw-ink-muted-64);
}
.dt-home__lead code {
  font-family: var(--aw-font-mono);
  font-size: 13px;
  padding: 2px 7px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
}
.dt-home__notice {
  margin: 16px 0 0;
  padding: 10px 14px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-status-waiting-bg);
  color: var(--aw-status-waiting);
  font-size: 13.5px;
}
.dt-home__group {
  margin-top: 36px;
}
.dt-home__group-title {
  margin: 0 0 14px;
  font-family: var(--aw-font-display);
  font-size: 19px;
  font-weight: 600;
}
.dt-home__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 12px;
}
.dt-home__card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 15px 16px;
  border: 1px solid var(--aw-divider);
  border-radius: var(--aw-radius-md);
  background: var(--aw-surface);
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.dt-home__card:hover {
  border-color: var(--aw-primary-line);
  transform: translateY(-2px);
}
.dt-home__card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--aw-ink);
}
.dt-home__card-slug {
  font-family: var(--aw-font-mono);
  font-size: 11.5px;
  color: var(--aw-ink-muted);
}

/* ---------- 移动端抽屉 ---------- */
.dt-drawer :deep(.el-drawer__body) {
  padding: 18px 14px;
}

/* ---------- 响应式 ---------- */
@media (max-width: 1280px) {
  .dt-layout {
    grid-template-columns: 252px minmax(0, 1fr);
  }
  .dt-toc {
    display: none;
  }
}
@media (max-width: 860px) {
  .dt-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .dt-side {
    display: none;
  }
  .dt-bar__menu {
    display: inline-flex;
  }
  .dt-head__title {
    font-size: 25px;
  }
}
</style>



