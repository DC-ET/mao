<template>
  <div class="system-settings">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>系统设置</span>
          <el-button @click="fetchSettings">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-table :data="settings" v-loading="loading" stripe>
        <el-table-column prop="category" label="分类" width="110" />
        <el-table-column prop="settingKey" label="配置键" width="190" />
        <el-table-column prop="description" label="说明" min-width="220" />
        <el-table-column prop="value" label="当前值" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.settingKey.endsWith('enabled')" :type="row.value === 'true' ? 'success' : 'info'" size="small">
              {{ row.value === 'true' ? '已启用' : '未启用' }}
            </el-tag>
            <span v-else>{{ row.value }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可编辑" width="90">
          <template #default="{ row }">
            <el-tag :type="row.editable === 1 ? 'success' : 'info'" size="small">
              {{ row.editable === 1 ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" :disabled="row.editable !== 1" @click="handleEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="编辑配置" width="480px">
      <el-form label-width="90px">
        <el-form-item label="配置键">
          <el-input :model-value="currentSetting?.settingKey" disabled />
        </el-form-item>
        <el-form-item label="配置值">
          <el-input v-model="settingValue" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSetting">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const settings = ref<any[]>([])
const dialogVisible = ref(false)
const currentSetting = ref<any | null>(null)
const settingValue = ref('')

async function fetchSettings() {
  loading.value = true
  try {
    const { data } = await api.get('/system-settings')
    settings.value = data || []
  } finally {
    loading.value = false
  }
}

function handleEdit(row: any) {
  currentSetting.value = row
  settingValue.value = row.value || ''
  dialogVisible.value = true
}

async function saveSetting() {
  if (!currentSetting.value) return
  await api.put(`/system-settings/${currentSetting.value.settingKey}`, { value: settingValue.value })
  ElMessage.success('配置已更新')
  dialogVisible.value = false
  fetchSettings()
}

onMounted(fetchSettings)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
