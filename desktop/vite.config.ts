import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'fs'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'generate-version',
      closeBundle() {
        const pkgPath = path.resolve(__dirname, 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const version = {
          version: pkg.version,
          buildTime: new Date().toISOString()
        }
        const distDir = path.resolve(__dirname, 'dist')
        if (!fs.existsSync(distDir)) {
          fs.mkdirSync(distDir, { recursive: true })
        }
        fs.writeFileSync(
          path.resolve(distDir, 'version.json'),
          JSON.stringify(version)
        )
      }
    }
  ],
  // 绝对路径，供 Nginx 部署；/tasks/:id 刷新时避免资源 404
  base: '/',
  server: {
    port: 5201
  }
})
