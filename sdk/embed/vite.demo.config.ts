import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// demo 本地验收页 dev server：模拟宿主系统（含路由切换与 context 变化）。
// SDK 产物以源码方式直接引入（alias 到 src/index.ts），无需先 build。
const rootDir = import.meta.dirname;

export default defineConfig({
  root: 'demo',
  plugins: [vue()],
  resolve: {
    alias: {
      '@mao/contracts': resolve(rootDir, '../../shared/contracts/src/index.ts'),
    },
  },
  server: {
    port: 5300,
  },
});
