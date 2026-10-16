<script setup lang="ts">
import launcherIcon from '../assets/launcher-icon.png';

defineProps<{
  /** 面板标题栏小头像：21px 下金色羽毛笔画仍可辨 */
  small?: boolean;
}>();
</script>

<template>
  <!-- 品牌图标：深色圆盘 + 金色羽毛（docs/assets/logo-design）。位图而非 SVG 描摹，
       保证五端同一视觉；由 style.css 按 small 切换尺寸。 -->
  <img
    class="mao-brand-icon"
    :class="{ 'mao-brand-icon--small': small }"
    :src="launcherIcon"
    alt=""
    aria-hidden="true"
    draggable="false"
  />
</template>
