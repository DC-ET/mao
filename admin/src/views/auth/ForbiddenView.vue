<template>
  <div class="forbidden">
    <el-result icon="warning" title="无权限访问" sub-title="当前账号没有访问该页面的权限，请联系管理员分配角色权限。">
      <template #extra>
        <el-button v-if="canGoHome" type="primary" @click="goHome">返回首页</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { pickHomePath } from '../../utils/home'

const router = useRouter()
const authStore = useAuthStore()

function goHome() {
  const path = pickHomePath((permission) => authStore.hasPermission(permission))
  if (path !== '/forbidden') router.push(path)
}

const canGoHome = computed(() => pickHomePath((permission) => authStore.hasPermission(permission)) !== '/forbidden')
</script>

<style scoped>
.forbidden {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}
</style>
