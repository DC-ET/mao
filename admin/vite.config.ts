import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: '/admin/',
    plugins: [vue()],
    resolve: {
      alias: {
        '@mao/contracts': path.resolve(__dirname, '../shared/contracts/src'),
      },
    },
    server: {
      port: 5200,
      proxy: {
        '/api': {
          target: env.MAO_API_PROXY || 'http://localhost:9080',
          changeOrigin: true,
          // 浮窗助手 SDK 的 /api/ws/stream WebSocket 走同源代理，必须开升级
          ws: true,
        },
        // 浮窗助手 SDK 产物：desktop dev server（:5201）由 public/ 提供；生产由 Nginx location / 直出
        '/embed': {
          target: 'http://localhost:5201',
          changeOrigin: true,
        },
      },
    },
  }
})
