import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import {
  Aim, ArrowDown, ArrowLeft, ArrowRight, Bell, BellFilled, CaretBottom, CaretTop,
  ChatDotRound, ChatLineSquare, Check, CircleCheck, CircleClose, Clock, Close, CloseBold,
  Cloudy, Connection, CopyDocument, Delete, Document, DocumentAdd, DocumentCopy, Download,
  Edit, EditPen, Files, Finished, Folder, FolderAdd, FolderChecked, FolderOpened, Grid,
  Hide, InfoFilled, Link, List, Loading, Lock, Message, Monitor, Moon, Odometer,
  Opportunity, PartlyCloudy, Picture, Plus, Position, Reading, Refresh, RefreshLeft,
  RefreshRight, Scissor, Search, Select, Setting, Share, Sort, Sunny, Sunrise,
  SwitchButton, Tickets, TrendCharts, Upload, User, VideoPause, VideoPlay, View,
  WarningFilled, ZoomIn, ZoomOut,
} from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import { useTheme } from './utils/theme'
import { initAuthStorage } from './utils/auth-storage'
import { useForegroundRecovery } from './composables/useForegroundRecovery'
import './style.css'
import 'monaco-editor/min/vs/editor/editor.main.css'

function markAndroidCapacitor() {
  try {
    const capacitor = (window as any).Capacitor
    if (capacitor?.getPlatform?.() === 'android') {
      document.documentElement.classList.add('android-capacitor')
      return
    }
    const host = window.location.hostname
    if (/Android/i.test(navigator.userAgent) && /^(localhost|127\.0\.0\.1)$/i.test(host)) {
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

  // 仅注册模板标签 / 字符串 icon 属性实际用到的图标（与 admin 同一按需口径）；
  // 局部 import 的图标不受影响。全量注册会让整套图标库（293 个）进主包
  const globalIcons = {
    Aim, ArrowDown, ArrowLeft, ArrowRight, Bell, BellFilled, CaretBottom, CaretTop,
    ChatDotRound, ChatLineSquare, Check, CircleCheck, CircleClose, Clock, Close, CloseBold,
    Cloudy, Connection, CopyDocument, Delete, Document, DocumentAdd, DocumentCopy, Download,
    Edit, EditPen, Files, Finished, Folder, FolderAdd, FolderChecked, FolderOpened, Grid,
    Hide, InfoFilled, Link, List, Loading, Lock, Message, Monitor, Moon, Odometer,
    Opportunity, PartlyCloudy, Picture, Plus, Position, Reading, Refresh, RefreshLeft,
    RefreshRight, Scissor, Search, Select, Setting, Share, Sort, Sunny, Sunrise,
    SwitchButton, Tickets, TrendCharts, Upload, User, VideoPause, VideoPlay, View,
    WarningFilled, ZoomIn, ZoomOut,
  }
  for (const [key, component] of Object.entries(globalIcons)) {
    app.component(key, component)
  }

  app.use(createPinia())
  app.use(router)
  app.use(ElementPlus, { locale: zhCn })

  app.mount('#app')
  // 挂载成功标记：安卓原生壳回前台存活探测（MainActivity APP_MOUNTED_PROBE_JS）使用
  ;(window as any).__MAO_APP_MOUNTED = true

  // Initialize theme after mount
  useTheme()

  // 安卓回前台恢复：检测连接断开 → 静默整页刷新（WebView 卡死由 MainActivity 原生兜底）
  useForegroundRecovery().init()
}

bootstrap()
