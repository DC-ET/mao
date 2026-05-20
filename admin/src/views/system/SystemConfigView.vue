<template>
  <div class="system-config">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>系统配置</span>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="基础配置" name="basic">
          <el-form :model="basicConfig" label-width="120px" class="config-form">
            <el-form-item label="系统名称">
              <el-input v-model="basicConfig.systemName" />
            </el-form-item>
            <el-form-item label="管理员邮箱">
              <el-input v-model="basicConfig.adminEmail" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSaveBasic">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="限流配置" name="rateLimit">
          <el-form :model="rateLimitConfig" label-width="120px" class="config-form">
            <el-form-item label="用户 QPS">
              <el-input-number v-model="rateLimitConfig.userQps" :min="1" :max="100" />
            </el-form-item>
            <el-form-item label="模型 QPM">
              <el-input-number v-model="rateLimitConfig.modelQpm" :min="1" :max="1000" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSaveRateLimit">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="通知配置" name="notification">
          <el-form :model="notificationConfig" label-width="120px" class="config-form">
            <el-form-item label="飞书 Webhook">
              <el-input v-model="notificationConfig.feishuWebhook" placeholder="飞书机器人 Webhook URL" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleTestNotification">测试通知</el-button>
              <el-button type="primary" @click="handleSaveNotification">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="认证配置" name="auth">
          <el-form :model="authConfig" label-width="120px" class="config-form">
            <el-divider content-position="left">飞书 OAuth</el-divider>
            <el-form-item label="App ID">
              <el-input v-model="authConfig.feishuAppId" placeholder="飞书应用 App ID" />
            </el-form-item>
            <el-form-item label="App Secret">
              <el-input v-model="authConfig.feishuAppSecret" type="password" show-password placeholder="飞书应用 App Secret" />
            </el-form-item>
            <el-divider content-position="left">LDAP</el-divider>
            <el-form-item label="服务器地址">
              <el-input v-model="authConfig.ldapUrl" placeholder="ldap://10.0.0.1:389" />
            </el-form-item>
            <el-form-item label="Base DN">
              <el-input v-model="authConfig.ldapBaseDn" placeholder="dc=example,dc=com" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSaveAuth">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const activeTab = ref('basic')
const loading = ref(false)

const basicConfig = ref({
  systemName: '',
  siteLogo: ''
})

const rateLimitConfig = ref({
  userQps: 10,
  modelQpm: 60
})

const notificationConfig = ref({
  feishuWebhook: ''
})

const authConfig = ref({
  feishuAppId: '',
  feishuAppSecret: '',
  ldapUrl: '',
  ldapBaseDn: ''
})

async function fetchConfig() {
  loading.value = true
  try {
    const { data } = await api.get('/system/config')
    if (data) {
      basicConfig.value.systemName = data['site.name'] || ''
      basicConfig.value.siteLogo = data['site.logo'] || ''
      rateLimitConfig.value.userQps = parseInt(data['rate-limit.user-qps'] || '10')
      rateLimitConfig.value.modelQpm = parseInt(data['rate-limit.model-qpm'] || '60')
      notificationConfig.value.feishuWebhook = data['notification.feishu-webhook'] || ''
      authConfig.value.feishuAppId = data['feishu.app_id'] || ''
      authConfig.value.feishuAppSecret = data['feishu.app_secret'] || ''
      authConfig.value.ldapUrl = data['ldap.url'] || ''
      authConfig.value.ldapBaseDn = data['ldap.base_dn'] || ''
    }
  } finally {
    loading.value = false
  }
}

async function handleSaveBasic() {
  try {
    await api.put('/system/config', {
      'site.name': basicConfig.value.systemName,
      'site.logo': basicConfig.value.siteLogo
    })
    ElMessage.success('保存成功')
  } catch {
    ElMessage.error('保存失败')
  }
}

async function handleSaveRateLimit() {
  try {
    await api.put('/system/config', {
      'rate-limit.user-qps': String(rateLimitConfig.value.userQps),
      'rate-limit.model-qpm': String(rateLimitConfig.value.modelQpm)
    })
    ElMessage.success('保存成功')
  } catch {
    ElMessage.error('保存失败')
  }
}

async function handleSaveNotification() {
  try {
    await api.put('/system/config', {
      'notification.feishu-webhook': notificationConfig.value.feishuWebhook
    })
    ElMessage.success('保存成功')
  } catch {
    ElMessage.error('保存失败')
  }
}

async function handleSaveAuth() {
  try {
    await api.put('/system/config', {
      'feishu.app_id': authConfig.value.feishuAppId,
      'feishu.app_secret': authConfig.value.feishuAppSecret,
      'ldap.url': authConfig.value.ldapUrl,
      'ldap.base_dn': authConfig.value.ldapBaseDn
    })
    ElMessage.success('保存成功')
  } catch {
    ElMessage.error('保存失败')
  }
}

function handleTestNotification() {
  ElMessage.info('测试通知功能开发中')
}

onMounted(fetchConfig)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.config-form {
  max-width: 600px;
  margin-top: 20px;
}
</style>
