import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    // 与 Vue Router / 生产 Nginx 一致：管理后台挂在同一域名的 /admin/
    base: '/admin/',
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
        },
      },
    },
  }
})
