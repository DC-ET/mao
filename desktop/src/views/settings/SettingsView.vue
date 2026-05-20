<template>
  <div class="settings">
    <el-card>
      <template #header>
        <h2>设置</h2>
      </template>

      <el-tabs v-model="activeTab">
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
              <el-radio-group v-model="generalSettings.theme">
                <el-radio value="light">浅色</el-radio>
                <el-radio value="dark">深色</el-radio>
                <el-radio value="auto">跟随系统</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSaveGeneral">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="关于" name="about">
          <div class="about-info">
            <h3>Agent 工作台</h3>
            <p>版本: {{ appVersion }}</p>
            <p>平台: {{ platform }}</p>
            <p>基于 Electron + Vue 3 构建</p>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>
      getPlatform: () => Promise<string>
    }
  }
}

const activeTab = ref('general')
const appVersion = ref('')
const platform = ref('')

const generalSettings = ref({
  serverUrl: 'http://localhost:9080',
  language: 'zh-CN',
  theme: 'light'
})

async function loadSettings() {
  // Load from localStorage
  const saved = localStorage.getItem('settings')
  if (saved) {
    Object.assign(generalSettings.value, JSON.parse(saved))
  }

  // Get app info from Electron
  if (window.electronAPI) {
    appVersion.value = await window.electronAPI.getAppVersion()
    platform.value = await window.electronAPI.getPlatform()
  } else {
    appVersion.value = 'Web'
    platform.value = navigator.platform
  }
}

function handleSaveGeneral() {
  localStorage.setItem('settings', JSON.stringify(generalSettings.value))
  ElMessage.success('保存成功')
}

onMounted(loadSettings)
</script>

<style scoped>
.settings {
  padding: 20px 0;
}

.settings-form {
  max-width: 600px;
}

.about-info {
  text-align: center;
  padding: 40px 0;
}

.about-info h3 {
  margin: 0 0 16px 0;
  color: #303133;
}

.about-info p {
  color: #606266;
  margin: 8px 0;
}
</style>
