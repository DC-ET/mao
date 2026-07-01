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
        const version = {
          version: Date.now().toString(),
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
  base: './',
  server: {
    port: 5201
  }
})
