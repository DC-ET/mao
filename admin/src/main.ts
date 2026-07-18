import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import './style.css'
import './styles/responsive.css'
import { useAuthStore } from './stores/auth'

const app = createApp(App)

// Register all Element Plus icons
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

// Restore current user info on startup so the header/username and permission
// checks work immediately after a page refresh.
const authStore = useAuthStore()
if (localStorage.getItem('token')) {
  authStore.fetchUserInfo().catch(() => {})
}

app.mount('#app')
