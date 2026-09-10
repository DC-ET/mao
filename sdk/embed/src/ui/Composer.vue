<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PageAuthorizationLevel } from '../page';
import {
  MAX_ATTACHMENTS,
  attachmentFileName,
  collectPastedFiles,
  createPendingAttachment,
  formatAttachmentSize,
  isImageAttachment,
  type PendingAttachment,
} from '../core/attachment';
import PageAuthSwitcher from './PageAuthSwitcher.vue';

const props = defineProps<{
  running: boolean;
  quotedSelection: string | null;
  pageAuthorization: PageAuthorizationLevel;
  /** 后台配置的单文件大小上限（MB） */
  maxAttachmentMb: number;
}>();

const emit = defineEmits<{
  send: [content: string, attachments: PendingAttachment[]];
  stop: [];
  clearSelection: [];
  setPageAuthorization: [level: PageAuthorizationLevel];
}>();

const text = ref('');
/** 待发附件：粘贴进来后暂存，发送时上传 */
const attachments = ref<PendingAttachment[]>([]);
/** 附件相关提示（超限/超大小），数秒后自动消失 */
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const inputEl = ref<HTMLTextAreaElement | null>(null);
const authEl = ref<InstanceType<typeof PageAuthSwitcher> | null>(null);

const canSend = computed(() => (text.value.trim().length > 0 || attachments.value.length > 0) && !props.running);

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

watch(text, () => nextTick(autoGrow));

function showNotice(message: string) {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
    noticeTimer = null;
  }, 4000);
}

function revokePreview(attachment: PendingAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function clearAttachments() {
  attachments.value.forEach(revokePreview);
  attachments.value = [];
}

/** 粘贴得到的文件：图片与文件一起暂存，超限/超大小当场提示并跳过 */
function onPaste(e: ClipboardEvent) {
  const files = collectPastedFiles(e.clipboardData);
  if (files.length === 0) return;
  // 有文件就阻止默认粘贴，避免文件内容被当成文本/路径插进输入框
  e.preventDefault();
  let skippedLimit = false;
  let skippedSize: string | null = null;
  for (const file of files) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      skippedLimit = true;
      continue;
    }
    if (file.size === 0) {
      skippedSize = attachmentFileName(file);
      continue;
    }
    if (file.size > props.maxAttachmentMb * 1024 * 1024) {
      skippedSize = attachmentFileName(file);
      continue;
    }
    attachments.value.push(createPendingAttachment(file));
  }
  if (skippedLimit) {
    showNotice(`最多添加 ${MAX_ATTACHMENTS} 个附件，超出部分已忽略`);
  } else if (skippedSize) {
    showNotice(`${skippedSize} 超过 ${props.maxAttachmentMb}MB 限制或为空文件，已忽略`);
  } else {
    notice.value = null;
  }
}

function removeAttachment(index: number) {
  const item = attachments.value[index];
  if (item) revokePreview(item);
  attachments.value.splice(index, 1);
}

function onSend() {
  // 执行中可继续打字，但不发出：embed 无消息队列，发出会被服务端拒绝并丢掉草稿
  if (props.running) return;
  const content = text.value.trim();
  if (!content && attachments.value.length === 0) return;
  emit('send', content, attachments.value);
  text.value = '';
  clearAttachments();
  notice.value = null;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
}

/** 供 ChatPanel 在浮窗展开时调用 */
function focus() {
  inputEl.value?.focus();
}

function closeMenu() {
  authEl.value?.close();
}

function isMenuOpen() {
  return authEl.value?.isOpen() === true;
}

onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
  attachments.value.forEach(revokePreview);
});

defineExpose({ focus, closeMenu, isMenuOpen });
</script>

<template>
  <div class="mao-composer">
    <div class="mao-composer__card">
      <div v-if="quotedSelection" class="mao-chip">
        <span class="mao-chip__label">讨论</span>
        <span class="mao-chip__text">{{ quotedSelection }}</span>
        <button class="mao-chip__close" type="button" aria-label="移除引用" @click="emit('clearSelection')">×</button>
      </div>
      <div v-if="attachments.length > 0" class="mao-composer__attachments">
        <div v-for="(item, index) in attachments" :key="item.id" class="mao-attach">
          <img v-if="item.previewUrl" class="mao-attach__thumb" :src="item.previewUrl" alt="" />
          <span v-else class="mao-attach__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm-1 7V3.5L18.5 9Z"/></svg>
          </span>
          <span class="mao-attach__name" :title="attachmentFileName(item.file)">
            {{ attachmentFileName(item.file) }}
            <span v-if="!isImageAttachment(item.file)" class="mao-attach__size">{{ formatAttachmentSize(item.file.size) }}</span>
          </span>
          <button class="mao-attach__close" type="button" aria-label="移除附件" @click="removeAttachment(index)">×</button>
        </div>
      </div>
      <textarea
        ref="inputEl"
        v-model="text"
        class="mao-composer__input"
        rows="1"
        aria-label="消息输入框"
        placeholder="告诉 Agent 你想做什么..."
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <div v-if="notice" class="mao-composer__notice" role="status">{{ notice }}</div>
      <div class="mao-composer__toolbar">
        <PageAuthSwitcher
          ref="authEl"
          :level="pageAuthorization"
          @set-level="(level) => emit('setPageAuthorization', level)"
        />
        <button
          v-if="running"
          class="mao-composer__send mao-composer__stop"
          type="button"
          title="停止"
          aria-label="停止"
          @click="emit('stop')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
        </button>
        <button
          v-else
          class="mao-composer__send"
          type="button"
          :class="{ 'mao-composer__send--active': canSend }"
          :disabled="!canSend"
          title="发送 (Enter)"
          aria-label="发送"
          @click="onSend"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 19V5M12 5 5 12M12 5l7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
