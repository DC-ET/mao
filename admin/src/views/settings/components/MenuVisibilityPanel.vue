<template>
  <section id="setting-group-menu-visibility" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">菜单可见性</span>
          <span class="group-hint">部署级全局生效，所有账号一致</span>
        </div>
      </template>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="隐藏仅影响侧边栏菜单展示，不影响访问权限；被隐藏页面的路由与权限校验不变，仍可通过网址直接访问。如需收回访问权限，请使用「角色权限」。"
        class="config-tip"
      />

      <div :id="MENU_VISIBILITY_FIELD_ID" v-loading="loading" class="menu-visibility-body">
        <div v-for="group in menuGroups" :key="group.id" class="menu-group">
          <div class="menu-group-head">
            <span class="menu-group-title">{{ group.label || '概览' }}</span>
            <span class="menu-group-actions">
              <el-button link type="primary" size="small" :disabled="!canWrite" @click="showGroup(group)">全选</el-button>
              <el-button link type="primary" size="small" :disabled="!canWrite" @click="hideGroup(group)">全不选</el-button>
            </span>
          </div>
          <div v-for="item in group.items" :key="item.index" class="menu-row">
            <div class="menu-row-text">
              <span class="menu-row-label">{{ item.label }}</span>
              <span class="menu-row-index">{{ item.index }}</span>
            </div>
            <div class="menu-row-control">
              <span v-if="item.index === SETTINGS_MENU_INDEX" class="menu-row-hint">系统设置不可隐藏</span>
              <el-switch
                :model-value="!draft.has(item.index)"
                :disabled="!canWrite || item.index === SETTINGS_MENU_INDEX"
                @change="(val: string | number | boolean) => toggle(item.index, val === true)"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="panel-actions">
        <el-button :disabled="!canWrite || draft.size === 0" @click="restoreDefault">恢复默认（全部显示）</el-button>
        <el-button type="primary" :disabled="!canWrite || !dirty" :loading="saving" @click="save">保存</el-button>
      </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../api'
import { useMenuStore } from '../../../stores/menu'
import { menuGroups, type MenuGroupDef } from '../../../utils/menuNav'
import { MENU_VISIBILITY_FIELD_ID } from '../settingsSearchCatalog'

const ADMIN_MENU_HIDDEN_KEY = 'admin.menu.hidden'
/** 「系统设置」是菜单配置的唯一入口，不可隐藏（后端 validateValue 同步拒收）。 */
const SETTINGS_MENU_INDEX = '/settings'
/** 全部菜单 index（按菜单声明顺序），保存时据此收敛输出并丢弃已不存在的历史 index。 */
const ALL_MENU_INDEXES = menuGroups.flatMap(group => group.items.map(item => item.index))

const props = defineProps<{ canWrite: boolean }>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const menuStore = useMenuStore()
/** 草稿 = 被隐藏的菜单 index 集合（开=显示，所以在草稿里即隐藏）。 */
const draft = ref<Set<string>>(new Set())
const loading = ref(false)
const saving = ref(false)

function syncDraft() {
  draft.value = new Set(menuStore.hidden.filter(index => index !== SETTINGS_MENU_INDEX))
}

onMounted(async () => {
  if (!menuStore.loaded) {
    loading.value = true
    try {
      await menuStore.fetch()
    } finally {
      loading.value = false
    }
  }
  syncDraft()
})

// keepAlive 恢复时以 store 为准；本地有未保存修改（dirty）时保留草稿，避免切走再回来丢掉编辑。
onActivated(() => {
  if (menuStore.loaded && !dirty.value) syncDraft()
})

const dirty = computed(() => {
  const base = new Set(menuStore.hidden.filter(index => index !== SETTINGS_MENU_INDEX))
  if (base.size !== draft.value.size) return true
  for (const index of draft.value) {
    if (!base.has(index)) return true
  }
  return false
})

function toggle(index: string, visible: boolean) {
  if (index === SETTINGS_MENU_INDEX) return
  const next = new Set(draft.value)
  if (visible) next.delete(index)
  else next.add(index)
  draft.value = next
}

/** 全选（该组全部显示） */
function showGroup(group: MenuGroupDef) {
  const next = new Set(draft.value)
  for (const item of group.items) next.delete(item.index)
  draft.value = next
}

/** 全不选（该组全部隐藏）；「系统设置」项始终排除。 */
function hideGroup(group: MenuGroupDef) {
  const next = new Set(draft.value)
  for (const item of group.items) {
    if (item.index !== SETTINGS_MENU_INDEX) next.add(item.index)
  }
  draft.value = next
}

/** 恢复默认 = 全部显示：只清空草稿，仍需保存才落库。 */
function restoreDefault() {
  draft.value = new Set()
}

async function save() {
  if (!props.canWrite || saving.value) return
  const list = ALL_MENU_INDEXES.filter(index => draft.value.has(index))
  saving.value = true
  try {
    await api.put(`/system-settings/${ADMIN_MENU_HIDDEN_KEY}`, { value: JSON.stringify(list) })
    menuStore.setHidden(list)
    draft.value = new Set(list)
    ElMessage.success('菜单可见性已保存')
    emit('saved')
  } catch {
    /* 拦截器已提示失败 */
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; }
.group-hint { font-size: 12px; color: var(--mao-muted); }
.config-tip { margin-bottom: 12px; }
.menu-visibility-body { display: flex; flex-direction: column; gap: 14px; }
.menu-group { border: 1px solid var(--mao-border); border-radius: 8px; padding: 10px 14px 12px; }
.menu-group-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.menu-group-title { font-size: 13px; font-weight: 600; color: var(--mao-ink); }
.menu-group-actions { display: inline-flex; align-items: center; gap: 10px; }
.menu-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 0; }
.menu-row + .menu-row { border-top: 1px dashed var(--mao-border); }
.menu-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.menu-row-label { font-size: 13px; color: var(--mao-ink); }
.menu-row-index { font-size: 12px; color: var(--mao-muted); font-family: var(--el-font-family-mono, monospace); }
.menu-row-control { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.menu-row-hint { font-size: 12px; color: var(--mao-muted); }
.panel-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--mao-border); }
</style>
