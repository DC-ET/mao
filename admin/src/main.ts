import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { Close, Expand, Fold, Lock, Menu, Plus, User } from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import './style.css'
import './styles/responsive.css'
import { useAuthStore } from './stores/auth'

const app = createApp(App)

// 仅全局注册「字符串解析（prefix-icon）或未局部导入的模板标签」用到的图标；
// 其余图标由使用方自行按需 import，避免约 300 个图标全量进主包
const globalIcons = { Close, Expand, Fold, Lock, Menu, Plus, User }
for (const [key, component] of Object.entries(globalIcons)) {
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
