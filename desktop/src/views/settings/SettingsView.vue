<template>
  <div class="settings">
    <div class="settings-header">
      <h1 class="settings-title">设置</h1>
    </div>

    <el-tabs v-model="activeTab" class="settings-tabs">
      <el-tab-pane label="通用" name="general">
        <el-form :model="generalSettings" label-width="120px" class="settings-form">
          <el-form-item label="服务器地址">
            <el-input v-model="generalSettings.serverUrl" placeholder="http://localhost:8080" />
          </el-form-item>
          <el-form-item label="语言">
            <el-select v-model="generalSettings.language">
              <el-option label="中文" value="zh-CN" />
              <el-option label="English" value="en" />
            </el-select>
          </el-form-item>
          <el-form-item label="主题">
            <el-radio-group v-model="generalSettings.theme" @change="handleThemeChange">
              <el-radio value="light">浅色</el-radio>
              <el-radio value="dark">深色</el-radio>
              <el-radio value="auto">跟随系统</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" class="pill-btn" @click="handleSaveGeneral">保存</el-button>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="关于" name="about">
        <div class="about-info">
          <div class="about-logo">
            <el-icon :size="32"><Monitor /></el-icon>
          </div>
          <h3>Agent Workbench</h3>
          <p class="about-detail">版本: {{ appVersion }}</p>
          <p class="about-detail">平台: {{ platform }}</p>
          <p class="about-detail">基于 Electron + Vue 3 构建</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Monitor } from '@element-plus/icons-vue'
import { useTheme } from '../../utils/theme'

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>
      getPlatform: () => Promise<string>
    }
  }
}

const { setTheme } = useTheme()

const activeTab = ref('general')
const appVersion = ref('')
const platform = ref('')

const generalSettings = ref({
  serverUrl: 'http://localhost:9080',
  language: 'zh-CN',
  theme: 'light'
})

async function loadSettings() {
  const saved = localStorage.getItem('settings')
  if (saved) {
    Object.assign(generalSettings.value, JSON.parse(saved))
  }

  if (window.electronAPI) {
    appVersion.value = await window.electronAPI.getAppVersion()
    platform.value = await window.electronAPI.getPlatform()
  } else {
    appVersion.value = 'Web'
    platform.value = navigator.platform
  }
}

function handleThemeChange(theme: string) {
  setTheme(theme as 'light' | 'dark' | 'auto')
}

function handleSaveGeneral() {
  localStorage.setItem('settings', JSON.stringify(generalSettings.value))
  handleThemeChange(generalSettings.value.theme)
  ElMessage.success('保存成功')
}

onMounted(loadSettings)
</script>

<style scoped>
.settings {
  padding: var(--aw-space-section) var(--aw-space-xl);
  max-width: 700px;
  margin: 0 auto;
}

.settings-header {
  margin-bottom: var(--aw-space-xl);
}

.settings-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-display-lg);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0;
  line-height: 1.1;
}

.settings-form {
  max-width: 500px;
}

.settings-tabs :deep(.el-tabs__item) {
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-caption);
  letter-spacing: -0.224px;
}

.settings-tabs :deep(.el-tabs__active-bar) {
  background-color: var(--aw-primary);
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}

.about-info {
  text-align: center;
  padding: 48px 0;
}

.about-logo {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aw-primary);
  border-radius: var(--aw-radius-lg);
  color: var(--aw-on-primary);
  margin: 0 auto 16px;
}

.about-info h3 {
  margin: 0 0 16px;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
}

.about-detail {
  color: var(--aw-ink-muted-80);
  margin: 6px 0;
  font-size: var(--aw-text-body);
  letter-spacing: -0.374px;
}
</style>
