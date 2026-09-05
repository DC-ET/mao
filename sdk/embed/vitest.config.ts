import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

const rootDir = import.meta.dirname;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@mao/contracts': resolve(rootDir, '../../shared/contracts/src/index.ts'),
    },
  },
  test: {
    // happy-dom：controller / ws-client / UI 组件依赖 window、document、CustomEvent 等浏览器 API
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
  },
});
