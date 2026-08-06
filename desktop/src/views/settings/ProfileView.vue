<template>
  <div class="profile-page">
    <div class="page-header">
      <h1 class="page-title">个人信息</h1>
      <p class="page-desc">管理你的头像与个人资料，头像会展示在顶栏。</p>
    </div>

    <div class="profile-card">
      <!-- 头像区 -->
      <div class="avatar-section">
        <el-avatar :size="96" :src="previewUrl || authStore.user?.avatarUrl || ''" class="profile-avatar">
          <el-icon v-if="!previewUrl && !authStore.user?.avatarUrl" :size="44"><User /></el-icon>
        </el-avatar>
        <div class="avatar-actions">
          <el-upload
            accept=".jpg,.jpeg,.png,.webp"
            :show-file-list="false"
            :auto-upload="false"
            :on-change="handleFileChange"
          >
            <el-button size="small">更换头像</el-button>
          </el-upload>
          <el-button
            v-if="authStore.user?.avatarUrl && !previewUrl"
            size="small"
            type="danger"
            plain
            @click="markRemoveAvatar"
          >
            移除头像
          </el-button>
        </div>
        <div class="avatar-hint">支持 jpg / png / webp，单文件不超过 5MB</div>
      </div>

      <!-- 资料区 -->
      <el-form :model="form" label-position="top" class="profile-form">
        <el-form-item label="用户名">
          <el-input :model-value="authStore.user?.username || ''" disabled />
        </el-form-item>
        <el-form-item label="登录方式">
          <el-tag :type="authSourceTagType" size="small">{{ authSourceLabel }}</el-tag>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input
            v-model="form.displayName"
            :disabled="!isLocalUser"
            maxlength="128"
            show-word-limit
            placeholder="请输入显示名称"
          />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.email" :disabled="!isLocalUser" placeholder="请输入邮箱" />
        </el-form-item>
        <div v-if="!isLocalUser" class="profile-tip">
          LDAP / 飞书账号的显示名称与邮箱由系统维护，仅可修改头像。
        </div>
      </el-form>

      <div class="profile-actions">
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import type { UploadFile } from 'element-plus'
import { ElMessage } from 'element-plus'
import { User } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { uploadImages } from '../../utils/imageUpload'

const MAX_SIZE = 5 * 1024 * 1024

const authStore = useAuthStore()

const form = reactive({
  displayName: authStore.user?.displayName ?? '',
  email: authStore.user?.email ?? ''
})

const previewUrl = ref('')
const selectedFile = ref<File | null>(null)
const removeAvatarFlag = ref(false)
const saving = ref(false)

const isLocalUser = computed(() => authStore.user?.authSource === 'LOCAL')

const authSourceLabel = computed(() => {
  switch (authStore.user?.authSource) {
    case 'LOCAL':
      return '本地账号'
    case 'FEISHU':
      return '飞书'
    case 'LDAP':
      return 'LDAP 目录账号'
    default:
      return '—'
  }
})

const authSourceTagType = computed<'primary' | 'info'>(() =>
  isLocalUser.value ? 'primary' : 'info'
)

function handleFileChange(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  const isImage =
    /\.(jpe?g|png|webp)$/i.test(raw.name) ||
    ['image/jpeg', 'image/png', 'image/webp'].includes(raw.type)
  if (!isImage) {
    ElMessage.error('仅支持 jpg / png / webp 格式')
    return
  }
  if (raw.size > MAX_SIZE) {
    ElMessage.error('图片不能超过 5MB')
    return
  }
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
  }
  previewUrl.value = URL.createObjectURL(raw)
  selectedFile.value = raw
  removeAvatarFlag.value = false
}

function markRemoveAvatar() {
  removeAvatarFlag.value = true
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
  selectedFile.value = null
}

async function save() {
  if (saving.value) return
  if (isLocalUser.value && !form.displayName.trim()) {
    ElMessage.error('显示名称不能为空')
    return
  }
  saving.value = true
  try {
    // 上传新头像（local / OSS 双模式复用现有链路）
    let avatarUrl: string | null | undefined = authStore.user?.avatarUrl ?? null
    if (selectedFile.value) {
      const urls = await uploadImages([selectedFile.value])
      if (urls.length === 0) {
        // 上传失败：清理预览态并提示（uploadImages 内部已提示具体失败原因）
        clearPreview()
        ElMessage.error('头像上传失败，请重试')
        return
      }
      avatarUrl = urls[0]
    } else if (removeAvatarFlag.value) {
      // 传空字符串表示移除头像（null 表示不修改）
      avatarUrl = ''
    }

    await api.put('/users/me/profile', {
      displayName: isLocalUser.value ? form.displayName : undefined,
      email: isLocalUser.value ? form.email : undefined,
      avatarUrl
    })

    // 清理预览态（保存已成功）
    clearPreview()

    // 刷新用户信息失败不影响保存结果，顶栏头像会在下次成功刷新时同步
    try {
      await authStore.fetchUserInfo()
    } catch {
      // 忽略：已保存成功，仅本地缓存未刷新
    }

    ElMessage.success('保存成功')
  } catch {
    // 保存失败：保留预览状态以便用户重试（具体错误已由 API 拦截器提示）
  } finally {
    saving.value = false
  }
}

function clearPreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
  selectedFile.value = null
  removeAvatarFlag.value = false
}

onBeforeUnmount(() => {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
  }
})
</script>

<style scoped>
.profile-page {
  max-width: 560px;
}

.profile-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-md);
  padding: 24px;
}

.avatar-section {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--aw-divider-soft);
  margin-bottom: 20px;
}

.profile-avatar {
  flex-shrink: 0;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
}

.avatar-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.avatar-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.profile-form {
  max-width: 360px;
}

.profile-tip {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 16px;
}

.profile-actions {
  margin-top: 8px;
  border-top: 1px solid var(--aw-divider-soft);
  padding-top: 16px;
}
</style>
