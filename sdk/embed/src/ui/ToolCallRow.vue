<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ToolCallItem } from '../types';
import MaoIcon from './MaoIcon.vue';
import ToolCallElapsed from './ToolCallElapsed.vue';
import { ICON_ARROW_DOWN, ICON_COPY, ICON_ERROR, ICON_SUCCESS, getToolIconDef } from './icons';
import { parseToolArgs, toolRowSummary } from './toolDisplay';
import { buildToolBodyView, prettyJsonOrRaw } from './toolViews';

/**
 * 单个工具调用行（对齐 desktop ToolCallCard）：
 * 行头 = 图标 + 一句话摘要 + 状态（耗时/转圈/成功√/失败×/结果未记录）+ 展开箭头；
 * 展开体优先富视图（diff/终端块/文件内容/命中列表/网页结果），解析不了回退原始输入输出。
 */
const props = defineProps<{
  toolCall: ToolCallItem;
  /** 单独渲染（组内只有一个调用）：行头带类型图标，充当组壳；多调用组内不重复挂图标 */
  standalone?: boolean;
}>();

const isExpanded = ref(false);
const showRawIo = ref(false);
const showFullResult = ref(false);

const args = computed(() => parseToolArgs(props.toolCall.argsText));
const summary = computed(() => toolRowSummary(props.toolCall.summary, props.toolCall.toolName, args.value));
const toolIcon = computed(() => getToolIconDef(props.toolCall.toolName));
const bodyView = computed(() => buildToolBodyView(props.toolCall.toolName, args.value, props.toolCall.resultText));

const formattedInput = computed(() => prettyJsonOrRaw(props.toolCall.argsText));

/** 未截断的完整输出文本；图片结果展示其 content 字段 */
const fullResultText = computed(() => {
  if (props.toolCall.imagePreview) {
    try {
      const obj = JSON.parse(props.toolCall.resultText) as { content?: unknown };
      if (typeof obj?.content === 'string') return obj.content;
    } catch { /* fall through */ }
  }
  return props.toolCall.resultText;
});

const isResultTruncated = computed(() => fullResultText.value.length > 4000);
const displayResultText = computed(() => {
  const full = fullResultText.value;
  if (isResultTruncated.value && !showFullResult.value) {
    return full.slice(0, 4000) + '\n…（输出已截断）';
  }
  return full;
});

/** 有可展开内容才显示箭头并响应点击（纯状态行如「结果未记录」点了不展开） */
const hasBody = computed(() =>
  !!(formattedInput.value || fullResultText.value || props.toolCall.imagePreview));

function toggleExpand() {
  if (!hasBody.value) return;
  isExpanded.value = !isExpanded.value;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 权限拒绝/不可用：退回 execCommand（Shadow DOM 内 select 仍有效）
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
}

// ── 图片灯箱：teleport 到浮窗根节点（Shadow DOM 内 fixed 才不被宿主页裁剪） ──
const lightboxSrc = ref<string | null>(null);
const teleportTo = ref<HTMLElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);

onMounted(() => {
  const rootNode = rootEl.value?.getRootNode();
  const root = rootNode instanceof ShadowRoot || rootNode instanceof Document
    ? rootNode.querySelector('.mao-root')
    : null;
  teleportTo.value = root instanceof HTMLElement ? root : null;
  document.addEventListener('keydown', onKeydown, true);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !lightboxSrc.value) return;
  e.preventDefault();
  e.stopPropagation();
  lightboxSrc.value = null;
}

function openLightbox(src: string) {
  lightboxSrc.value = src;
}

function closeLightbox() {
  lightboxSrc.value = null;
}
</script>

<template>
  <div ref="rootEl" class="mao-toolrow" :class="[`mao-toolrow--${toolCall.status}`, { 'mao-toolrow--standalone': standalone }]">
    <button
      type="button"
      class="mao-toolrow__header"
      :aria-expanded="hasBody ? isExpanded : undefined"
      @click="toggleExpand"
    >
      <span class="mao-toolrow__info">
        <MaoIcon v-if="standalone" :icon="toolIcon" :size="14" class="mao-toolrow__icon" />
        <span class="mao-toolrow__summary">{{ summary }}</span>
      </span>
      <span class="mao-toolrow__status">
        <ToolCallElapsed v-if="toolCall.status === 'running'" :started-at-ms="toolCall.startedAtMs" />
        <span v-if="toolCall.status === 'running'" class="mao-spinner" aria-hidden="true" />
        <MaoIcon v-else-if="toolCall.status === 'done'" :icon="ICON_SUCCESS" :size="13" class="mao-toolrow__mark mao-toolrow__mark--ok" />
        <MaoIcon v-else-if="toolCall.status === 'error'" :icon="ICON_ERROR" :size="13" class="mao-toolrow__mark mao-toolrow__mark--fail" />
        <span v-else class="mao-toolrow__unknown">结果未记录</span>
        <MaoIcon
          v-if="hasBody"
          :icon="ICON_ARROW_DOWN"
          :size="12"
          class="mao-chevron"
          :class="{ 'mao-chevron--open': isExpanded }"
        />
      </span>
    </button>

    <div v-if="isExpanded && hasBody" class="mao-toolrow__body">
      <template v-if="bodyView">
        <!-- edit_file 行级 diff -->
        <div v-if="bodyView.kind === 'diff'" class="mao-diff">
          <template v-for="(block, bi) in bodyView.blocks" :key="bi">
            <div v-if="block.kind === 'gap'" class="mao-diff__gap">⋯ {{ block.count }} 行未变化</div>
            <div
              v-for="(line, li) in block.kind === 'hunk' ? block.lines : []"
              :key="`${bi}-${li}`"
              class="mao-diff__line"
              :class="`mao-diff__line--${line.type}`"
            >
              <span class="mao-diff__sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
              <span class="mao-diff__text">{{ line.text === '' ? ' ' : line.text }}</span>
            </div>
          </template>
        </div>

        <!-- shell 终端会话块 -->
        <div v-else-if="bodyView.kind === 'shell'" class="mao-shell">
          <div class="mao-shell__scroll">
            <div v-if="bodyView.primary" class="mao-shell__cmd">
              <span class="mao-shell__prompt">{{ bodyView.primaryLabel === '命令' ? '$' : '›' }}</span>
              <span v-if="bodyView.primaryLabel !== '命令'" class="mao-shell__tag">{{ bodyView.primaryLabel }}</span>
              <span class="mao-shell__text">{{ bodyView.primary }}</span>
            </div>
            <div v-if="bodyView.output || bodyView.error" class="mao-shell__divider" />
            <pre v-if="bodyView.error" class="mao-shell__out mao-shell__out--error">{{ bodyView.error }}</pre>
            <pre v-else-if="bodyView.output" class="mao-shell__out">{{ bodyView.output }}</pre>
          </div>
          <button v-if="bodyView.output || bodyView.error" type="button" class="mao-copy-btn" title="复制" @click="copyText(bodyView.output || bodyView.error)">
            <MaoIcon :icon="ICON_COPY" :size="13" />
          </button>
        </div>

        <!-- read_file 文件内容（行号槽） -->
        <div v-else-if="bodyView.kind === 'file'" class="mao-file">
          <div class="mao-file__cols">
            <div class="mao-file__nos">
              <div v-for="n in bodyView.content.split('\n').length" :key="n" class="mao-file__no">{{ bodyView.startLine + n - 1 }}</div>
            </div>
            <pre class="mao-file__code"><code>{{ bodyView.content }}</code></pre>
          </div>
        </div>

        <!-- write_file 写入内容 -->
        <div v-else-if="bodyView.kind === 'write'" class="mao-file">
          <div class="mao-file__cols">
            <div class="mao-file__nos">
              <div v-for="n in bodyView.content.split('\n').length" :key="n" class="mao-file__no">{{ n }}</div>
            </div>
            <pre class="mao-file__code"><code>{{ bodyView.content }}</code></pre>
          </div>
        </div>

        <!-- glob_search 命中文件列表 -->
        <div v-else-if="bodyView.kind === 'glob'" class="mao-hits">
          <div v-if="bodyView.error" class="mao-hits__error">{{ bodyView.error }}</div>
          <div v-for="file in bodyView.files" :key="file" class="mao-hits__row">{{ file }}</div>
        </div>

        <!-- grep_search 按文件分组的命中行 -->
        <div v-else-if="bodyView.kind === 'grep'" class="mao-hits">
          <div v-if="bodyView.error" class="mao-hits__error">{{ bodyView.error }}</div>
          <template v-for="group in bodyView.groups" :key="group.file">
            <div class="mao-hits__file">{{ group.file }}</div>
            <div
              v-for="row in group.rows"
              :key="`${group.file}:${row.line}:${row.content}`"
              class="mao-hits__row"
              :class="{ 'mao-hits__row--ctx': row.contextual }"
            >{{ row.line }}: {{ row.content }}</div>
          </template>
        </div>

        <!-- web_search 结果列表 -->
        <div v-else-if="bodyView.kind === 'web-search'" class="mao-web">
          <div v-if="bodyView.error" class="mao-hits__error">{{ bodyView.error }}</div>
          <div v-for="(item, i) in bodyView.items" :key="i" class="mao-web__item">
            <a v-if="item.url" class="mao-web__title" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title || item.url }}</a>
            <span v-else class="mao-web__title">{{ item.title }}</span>
            <span class="mao-web__host">{{ item.url }}</span>
            <p v-if="item.content" class="mao-web__snippet">{{ item.content }}</p>
          </div>
        </div>

        <!-- open_web_page 正文（Markdown 已由工具侧转好，按纯文本保真展示避免二次渲染风险） -->
        <div v-else-if="bodyView.kind === 'web-page'" class="mao-webpage">
          <div v-if="bodyView.error" class="mao-hits__error">{{ bodyView.error }}</div>
          <a v-else-if="bodyView.url" class="mao-web__title" :href="bodyView.url" target="_blank" rel="noopener noreferrer">{{ bodyView.title || bodyView.url }}</a>
          <pre class="mao-webpage__content">{{ bodyView.content }}</pre>
        </div>

        <!-- 富视图底栏：结果徽标/摘要 + 原始输入输出开关 -->
        <div class="mao-toolrow__footer">
          <span v-if="bodyView.kind === 'shell' && bodyView.badge" class="mao-badge" :class="bodyView.badge.ok ? 'mao-badge--ok' : 'mao-badge--fail'">
            {{ bodyView.badge.text }}
          </span>
          <span v-if="bodyView.summary" class="mao-toolrow__footnote">{{ bodyView.summary }}</span>
          <button type="button" class="mao-linklike" @click="showRawIo = !showRawIo">
            {{ showRawIo ? '收起原始输入输出' : '查看原始输入输出' }}
          </button>
        </div>
        <template v-if="showRawIo">
          <div class="mao-io-label">输入</div>
          <div class="mao-code-block">
            <pre class="mao-code-block__pre"><code>{{ formattedInput }}</code></pre>
            <button type="button" class="mao-copy-btn" title="复制" @click="copyText(formattedInput)">
            <MaoIcon :icon="ICON_COPY" :size="13" />
          </button>
          </div>
          <div v-if="displayResultText" class="mao-io-label">输出</div>
          <div v-if="displayResultText" class="mao-code-block">
            <pre class="mao-code-block__pre"><code>{{ displayResultText }}</code></pre>
            <button type="button" class="mao-copy-btn" title="复制完整输出" @click="copyText(fullResultText)">
            <MaoIcon :icon="ICON_COPY" :size="13" />
          </button>
          </div>
          <div v-if="isResultTruncated" class="mao-toolrow__footer">
            <button type="button" class="mao-linklike" @click="showFullResult = !showFullResult">
              {{ showFullResult ? '收起完整输出' : '展开完整输出' }}
            </button>
          </div>
        </template>
      </template>

      <!-- 无富视图：输入 + 输出原始展示 -->
      <template v-else>
        <div v-if="formattedInput" class="mao-io-label">输入</div>
        <div v-if="formattedInput" class="mao-code-block">
          <pre class="mao-code-block__pre"><code>{{ formattedInput }}</code></pre>
          <button type="button" class="mao-copy-btn" title="复制" @click="copyText(formattedInput)">
            <MaoIcon :icon="ICON_COPY" :size="13" />
          </button>
        </div>
        <button
          v-if="toolCall.imagePreview"
          type="button"
          class="mao-toolrow__thumb"
          title="查看大图"
          @click="openLightbox(toolCall.imagePreview)"
        >
          <img class="mao-toolrow__image" :src="toolCall.imagePreview" alt="页面截图" />
        </button>
        <div v-if="displayResultText" class="mao-io-label">输出</div>
        <div v-if="displayResultText" class="mao-code-block">
          <pre class="mao-code-block__pre"><code>{{ displayResultText }}</code></pre>
          <button type="button" class="mao-copy-btn" title="复制完整输出" @click="copyText(fullResultText)">
            <MaoIcon :icon="ICON_COPY" :size="13" />
          </button>
        </div>
        <div v-if="isResultTruncated" class="mao-toolrow__footer">
          <button type="button" class="mao-linklike" @click="showFullResult = !showFullResult">
            {{ showFullResult ? '收起完整输出' : '展开完整输出' }}
          </button>
        </div>
      </template>
    </div>

    <Teleport :to="teleportTo ?? 'body'" :disabled="!teleportTo">
      <div
        v-if="lightboxSrc"
        class="mao-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="查看大图"
        @click="closeLightbox"
      >
        <img class="mao-lightbox__img" :src="lightboxSrc" alt="" @click.stop />
        <button type="button" class="mao-lightbox__close" title="关闭" aria-label="关闭" @click="closeLightbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>
