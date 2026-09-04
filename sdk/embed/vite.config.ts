import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve } from 'node:path';

// SDK 库构建：IIFE 单文件，样式由 css-injected-by-js 内联进 JS（运行时注入 Shadow DOM）。
// 产物部署到 https://mao.etarch.cn/embed/mao-chat.js（见 desktop/public/embed 接线）。
export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ styleId: 'mao-chat-embed-style' })],
  resolve: {
    alias: {
      '@mao/contracts': resolve(__dirname, '../../shared/contracts/src/index.ts'),
    },
  },
  build: {
    target: 'es2018',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MaoChat',
      formats: ['iife'],
      fileName: () => 'mao-chat.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 900,
  },
});
