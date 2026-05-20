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
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

const activeTab = ref('basic')

const basicConfig = ref({
  systemName: 'Agent 工作台',
  adminEmail: ''
})

const rateLimitConfig = ref({
  userQps: 10,
  modelQpm: 60
})

const notificationConfig = ref({
  feishuWebhook: ''
})

function handleSaveBasic() {
  // TODO: Save basic config
  ElMessage.success('保存成功')
}

function handleSaveRateLimit() {
  // TODO: Save rate limit config
  ElMessage.success('保存成功')
}

function handleSaveNotification() {
  // TODO: Save notification config
  ElMessage.success('保存成功')
}

function handleTestNotification() {
  // TODO: Test notification
  ElMessage.info('测试通知功能开发中')
}
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
