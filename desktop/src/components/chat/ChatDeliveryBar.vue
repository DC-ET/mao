<template>
  <!-- 发送媒体投递卡片（统一发送媒体方案 2026-11-18 D6/§7.1）：该轮 send_image / send_file 的
       会话副本画在最终回复下方、文件变更面板同一层。图片进网格（点击大图预览）；
       文件卡片点击主区直接在中心「文件预览」Tab 查看，右侧提供独立下载按钮。 -->
  <div v-if="deliveries.length > 0" class="chat-delivery-bar">
    <div v-if="imageDeliveries.length > 0" class="delivery-images">
      <el-image
        v-for="(d, idx) in imageDeliveries"
        :key="keyOf(d)"
        :src="srcOf(d)"
        :preview-src-list="imageUrls"
        :initial-index="idx"
        :alt="d.filename"
        :title="d.filename"
        :fit="imageDeliveries.length === 1 ? 'contain' : 'cover'"
        class="delivery-image"
        :class="{ 'is-single': imageDeliveries.length === 1 }"
        :preview-teleported="true"
      >
        <template #error>
          <div class="delivery-image-error" :title="d.filename">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
            <span class="delivery-image-error-name">{{ d.filename }}</span>
          </div>
        </template>
      </el-image>
    </div>

    <div v-if="fileDeliveries.length > 0" class="delivery-files">
      <div
        v-for="d in fileDeliveries"
        :key="keyOf(d)"
        class="delivery-file"
        :class="`is-${fileMeta(d).category}`"
      >
        <button
          type="button"
          class="delivery-file-main"
          :title="fileTooltip(d)"
          :aria-label="filePreviewAriaLabel(d)"
          @click="handleFileOpen(d)"
        >
          <span class="delivery-file-badge" aria-hidden="true">
            <!-- archive -->
            <svg v-if="fileMeta(d).category === 'archive'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="4" rx="1" />
              <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
              <path d="M10 12h4" />
            </svg>
            <!-- pdf -->
            <svg v-else-if="fileMeta(d).category === 'pdf'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 13h6" />
              <path d="M9 17h4" />
              <path d="M9 9h1" />
            </svg>
            <!-- spreadsheet -->
            <svg v-else-if="fileMeta(d).category === 'spreadsheet'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M3 15h18" />
              <path d="M9 3v18" />
            </svg>
            <!-- document -->
            <svg v-else-if="fileMeta(d).category === 'document'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" />
              <path d="M8 17h6" />
              <path d="M8 9h2" />
            </svg>
            <!-- presentation -->
            <svg v-else-if="fileMeta(d).category === 'presentation'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="12" rx="2" />
              <path d="M8 20l4-4 4 4" />
              <path d="M12 16v4" />
              <path d="M8 12v-2" />
              <path d="M12 12V8" />
              <path d="M16 12v-3" />
            </svg>
            <!-- code -->
            <svg v-else-if="fileMeta(d).category === 'code'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="m10 13-2 2 2 2" />
              <path d="m14 13 2 2-2 2" />
            </svg>
            <!-- media -->
            <svg v-else-if="fileMeta(d).category === 'media'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <polygon points="10 8.5 16 12 10 15.5 10 8.5" fill="currentColor" stroke="none" />
            </svg>
            <!-- package -->
            <svg v-else-if="fileMeta(d).category === 'package'" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16.5 9.4 7.55 4.24" />
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.29 7 12 12 20.71 7" />
              <line x1="12" y1="22" x2="12" y2="12" />
            </svg>
            <!-- generic -->
            <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </span>

          <span class="delivery-file-body">
            <span class="delivery-file-name">{{ d.filename }}</span>
            <span class="delivery-file-meta">
              <span class="delivery-file-kind">{{ fileMeta(d).typeLabel }}</span>
              <template v-if="d.bytes != null">
                <span class="delivery-file-sep" aria-hidden="true">·</span>
                <span class="delivery-file-size">{{ formatSize(d.bytes) }}</span>
              </template>
            </span>
          </span>
        </button>

        <button
          type="button"
          class="delivery-file-download"
          :class="{ 'is-downloading': downloadingKeys.has(keyOf(d)) }"
          :disabled="downloadingKeys.has(keyOf(d))"
          :title="`下载 ${d.filename}`"
          :aria-label="`下载文件：${d.filename}`"
          @click.stop="handleFileDownload(d)"
        >
          <span v-if="downloadingKeys.has(keyOf(d))" class="delivery-download-spinner" aria-hidden="true"></span>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import type { SendDelivery } from '../../types/chat'
import { downloadDeliveryUrl } from '../../composables/workspace-file-provider'
import { formatSize } from '../../utils/file-manager'
import { resolveDeliveryFileMeta, type DeliveryFileMeta } from '../../utils/deliveryFileMeta'
import { deliveryKey, resolveDeliveryUrlWithToken } from '../../utils/deliveryUrl'

const props = defineProps<{
  deliveries: SendDelivery[]
}>()

/** TaskView 注入：存在时点击卡片主区在中心「文件预览」Tab 打开；只读分享页无此注入时回落为下载。 */
const openDeliveryFile = inject<((delivery: SendDelivery) => void) | null>('openDeliveryFile', null)

/** 下载中集合按 delivery 身份（稳定 key），不用含 token 的 resolved URL（token 轮换会误判）。 */
const downloadingKeys = reactive(new Set<string>())

const imageDeliveries = computed(() => props.deliveries.filter(d => d.kind === 'image'))
const imageUrls = computed(() => imageDeliveries.value.map(d => resolveDeliveryUrlWithToken(d)))
const fileDeliveries = computed(() => props.deliveries.filter(d => d.kind !== 'image'))

/** 取数 URL：形态 A（ref）渲染期拼 workspace-download + token；形态 B/C 原样 url。 */
function srcOf(d: SendDelivery): string {
  return resolveDeliveryUrlWithToken(d)
}

/** 稳定 key：形态 A 用 ref，形态 B/C 用 url。 */
function keyOf(d: SendDelivery): string {
  return deliveryKey(d)
}

function fileMeta(d: SendDelivery): DeliveryFileMeta {
  return resolveDeliveryFileMeta(d)
}

function fileTooltip(d: SendDelivery): string {
  const meta = fileMeta(d).typeLabel
  const size = d.bytes != null ? ` · ${formatSize(d.bytes)}` : ''
  const actionHint = openDeliveryFile ? '点击在文件预览中查看' : '点击下载文件'
  return `${d.filename}\n${meta}${size} · ${actionHint}`
}

function filePreviewAriaLabel(d: SendDelivery): string {
  const size = d.bytes != null ? `，${formatSize(d.bytes)}` : ''
  const action = openDeliveryFile ? '预览文件' : '下载文件'
  return `${action}：${d.filename}（${fileMeta(d).typeLabel}${size}）`
}

function handleFileOpen(d: SendDelivery) {
  if (openDeliveryFile) {
    openDeliveryFile(d)
    return
  }
  void handleFileDownload(d)
}

async function handleFileDownload(d: SendDelivery) {
  const key = keyOf(d)
  if (downloadingKeys.has(key)) return
  downloadingKeys.add(key)
  try {
    const fileId = d.ref?.type === 'send-file' ? d.ref.id : undefined
    const result = await downloadDeliveryUrl(srcOf(d), d.filename, fileId != null ? { fileId } : undefined)
    if (!result.ok) {
      ElMessage.error(result.error || '下载失败')
    }
  } finally {
    downloadingKeys.delete(key)
  }
}
</script>

<style scoped>
.chat-delivery-bar {
  margin: 8px 0 4px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;
}

/* ─── 图片投递网格 ─── */

.delivery-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
}

.delivery-image {
  width: 120px;
  height: 120px;
  border-radius: var(--aw-radius-md);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.delivery-image.is-single {
  width: auto;
  height: auto;
  max-width: min(320px, 100%);
  max-height: 220px;
}

.delivery-image.is-single :deep(.el-image__inner) {
  display: block;
  width: auto;
  height: auto;
  max-width: min(320px, 100%);
  max-height: 220px;
}

.delivery-image:hover {
  border-color: color-mix(in srgb, var(--aw-primary) 42%, var(--aw-hairline));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.delivery-image-error {
  min-width: 120px;
  min-height: 88px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--aw-ink-muted-48);
  box-sizing: border-box;
}

.delivery-image-error-name {
  max-width: 200px;
  font-size: var(--aw-text-fine);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 文件投递卡片 ─── */

.delivery-files {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 8px;
  /* 父级是 align-items:flex-start 的纵向 flex，这里若不给确定宽度，wrap 容器会按文字内容收缩。
     短文件名的内容宽小于卡片 min-width，两张就放不进这个盒子、各占一行，即使聊天栏还有空位。
     拉满后按聊天栏折行；单张卡片仍受自身 max-width 约束，不会被拉成整行。 */
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.delivery-file {
  --df-fg: var(--aw-primary);
  --df-bg: var(--aw-primary-lighter);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: min(252px, 100%);
  max-width: min(388px, 100%);
  padding: 6px 8px 6px 6px;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  background: var(--aw-surface-pearl);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  color: var(--aw-ink);
  box-sizing: border-box;
  transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.delivery-file:hover {
  background: var(--aw-surface);
  border-color: color-mix(in srgb, var(--aw-primary) 42%, var(--aw-hairline));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.delivery-file-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 4px;
  border: 0;
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.delivery-file-main:active {
  transform: none;
}

.delivery-file-main:focus-visible {
  outline: 2px solid var(--aw-primary);
  outline-offset: 2px;
}

/* 类型主题色（亮色） */
.delivery-file.is-archive {
  --df-fg: #b45309;
  --df-bg: rgba(217, 119, 6, 0.11);
}

.delivery-file.is-pdf {
  --df-fg: #dc2626;
  --df-bg: rgba(220, 38, 38, 0.10);
}

.delivery-file.is-spreadsheet {
  --df-fg: #15803d;
  --df-bg: rgba(22, 163, 74, 0.10);
}

.delivery-file.is-document {
  --df-fg: #1d4ed8;
  --df-bg: rgba(37, 99, 235, 0.10);
}

.delivery-file.is-presentation {
  --df-fg: #c2410c;
  --df-bg: rgba(234, 88, 12, 0.10);
}

.delivery-file.is-code {
  --df-fg: #6d28d9;
  --df-bg: rgba(124, 58, 237, 0.10);
}

.delivery-file.is-media {
  --df-fg: #be185d;
  --df-bg: rgba(219, 39, 119, 0.10);
}

.delivery-file.is-package {
  --df-fg: #0f766e;
  --df-bg: rgba(13, 148, 136, 0.11);
}

.delivery-file-badge {
  width: 38px;
  height: 38px;
  border-radius: var(--aw-radius-sm);
  background: var(--df-bg);
  color: var(--df-fg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.delivery-file-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.delivery-file-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  line-height: 1.35;
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delivery-file-main:hover .delivery-file-name {
  color: var(--aw-primary);
}

.delivery-file-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: var(--aw-text-fine);
  line-height: 1.3;
  color: var(--aw-ink-muted-48);
  font-variant-numeric: tabular-nums;
}

.delivery-file-kind {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delivery-file-sep {
  flex-shrink: 0;
  opacity: 0.65;
}

.delivery-file-size {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.delivery-file-download {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-64);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}

.delivery-file-download:hover:not(:disabled) {
  background: var(--aw-primary-lighter);
  border-color: var(--aw-primary-line);
  color: var(--aw-primary);
}

.delivery-file-download:focus-visible {
  outline: 2px solid var(--aw-primary);
  outline-offset: 2px;
}

.delivery-file-download:disabled {
  cursor: wait;
  opacity: 0.7;
}

.delivery-download-spinner {
  width: 13px;
  height: 13px;
  border: 1.8px solid color-mix(in srgb, var(--aw-primary) 28%, transparent);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: delivery-dl-spin 0.75s linear infinite;
}

@keyframes delivery-dl-spin {
  to { transform: rotate(360deg); }
}

/* ─── 暗色模式 ─── */

[data-theme="dark"] .delivery-image {
  border-color: var(--aw-border);
}

[data-theme="dark"] .delivery-image:hover {
  border-color: color-mix(in srgb, var(--aw-primary-on-dark) 48%, var(--aw-border));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
}

[data-theme="dark"] .delivery-file {
  --df-fg: var(--aw-primary-on-dark);
  --df-bg: var(--aw-primary-lighter);
  background: var(--aw-surface);
  border-color: var(--aw-border);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
}

[data-theme="dark"] .delivery-file:hover {
  background: var(--aw-surface-hover);
  border-color: color-mix(in srgb, var(--aw-primary-on-dark) 48%, var(--aw-border));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
}

[data-theme="dark"] .delivery-file-main:hover .delivery-file-name {
  color: var(--aw-primary-on-dark);
}

[data-theme="dark"] .delivery-file.is-archive {
  --df-fg: #fbbf24;
  --df-bg: rgba(245, 158, 11, 0.16);
}

[data-theme="dark"] .delivery-file.is-pdf {
  --df-fg: #f87171;
  --df-bg: rgba(248, 113, 113, 0.16);
}

[data-theme="dark"] .delivery-file.is-spreadsheet {
  --df-fg: #4ade80;
  --df-bg: rgba(74, 222, 128, 0.15);
}

[data-theme="dark"] .delivery-file.is-document {
  --df-fg: #60a5fa;
  --df-bg: rgba(96, 165, 250, 0.16);
}

[data-theme="dark"] .delivery-file.is-presentation {
  --df-fg: #fb923c;
  --df-bg: rgba(251, 146, 60, 0.16);
}

[data-theme="dark"] .delivery-file.is-code {
  --df-fg: #c4b5fd;
  --df-bg: rgba(167, 139, 250, 0.16);
}

[data-theme="dark"] .delivery-file.is-media {
  --df-fg: #f472b6;
  --df-bg: rgba(244, 114, 182, 0.16);
}

[data-theme="dark"] .delivery-file.is-package {
  --df-fg: #2dd4bf;
  --df-bg: rgba(45, 212, 191, 0.16);
}

[data-theme="dark"] .delivery-file-download {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--aw-divider);
  color: var(--aw-ink-muted);
}

[data-theme="dark"] .delivery-file-download:hover:not(:disabled) {
  background: var(--aw-primary-lighter);
  border-color: var(--aw-primary-line);
  color: var(--aw-primary-on-dark);
}

/* ─── 触控、响应式与减动效 ─── */

@media (pointer: coarse) {
  .delivery-file-download {
    width: 36px;
    height: 36px;
  }
}

@media (max-width: 640px) {
  .delivery-files {
    width: 100%;
  }

  .delivery-file {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .delivery-image {
    width: 104px;
    height: 104px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .delivery-file,
  .delivery-file-download,
  .delivery-image {
    transition: none;
  }
}
</style>
