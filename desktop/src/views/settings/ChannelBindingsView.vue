<template>
  <div class="channel-binding-page">
    <div class="page-header">
      <h1 class="page-title">渠道绑定</h1>
      <p class="page-desc">
        把 Mao 账号绑到外部机器人渠道，绑定后即可在对应渠道里与 Agent 对话。三个渠道互不影响，可分别绑定或解绑。
      </p>
    </div>

    <el-tabs v-model="activeTab" class="channel-tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.key" :label="tab.label" :name="tab.key" lazy>
        <WeixinBotPanel v-if="tab.key === 'weixin'" />
        <FeishuBotPanel v-else-if="tab.key === 'feishu'" />
        <DingtalkBotPanel v-else />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import WeixinBotPanel from '../../components/channel-binding/WeixinBotPanel.vue'
import FeishuBotPanel from '../../components/channel-binding/FeishuBotPanel.vue'
import DingtalkBotPanel from '../../components/channel-binding/DingtalkBotPanel.vue'
import { CHANNEL_BINDING_TABS, resolveInitialChannelBindingTab, type ChannelBindingTabKey } from '../../components/channel-binding/tabs'

const route = useRoute()

const tabs = CHANNEL_BINDING_TABS
// URL 只认 ?tab= 一个查询参数：刷新、分享链接、钉钉授权回调回来后都落在同一个 Tab 上。
const activeTab = ref<ChannelBindingTabKey>(resolveInitialChannelBindingTab(route.query))
</script>

<style scoped>
.channel-binding-page {
  max-width: 720px;
}

.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 8px;
}

.page-desc {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
}

.channel-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.channel-tabs :deep(.el-tabs__item) {
  font-size: 13px;
  height: 34px;
  line-height: 34px;
  padding: 0 14px;
}

.channel-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
}
</style>
