import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import { useTheme } from './utils/theme'
import { initAuthStorage } from './utils/auth-storage'
import './style.css'
import 'monaco-editor/min/vs/editor/editor.main.css'

function markAndroidCapacitor() {
  try {
    const capacitor = (window as any).Capacitor
    const host = window.location.hostname
    const isAndroid = capacitor?.getPlatform?.() === 'android'
      || (/Android/i.test(navigator.userAgent) && /^(localhost|127\.0\.0\.1)$/i.test(host))
    if (isAndroid) {
      document.documentElement.classList.add('android-capacitor')
    }
  } catch {
    // 非 Capacitor 环境忽略
  }
}

async function bootstrap() {
  markAndroidCapacitor()
  await initAuthStorage()

  const app = createApp(App)

  // Register all Element Plus icons
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }

  app.use(createPinia())
  app.use(router)
  app.use(ElementPlus, { locale: zhCn })

  app.mount('#app')

  // Initialize theme after mount
  useTheme()
}

bootstrap()
