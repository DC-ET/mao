<template>
  <div class="desktop-page">
    <div class="page-header">
      <h1 class="page-title">桌面</h1>
      <p class="page-desc">桌面客户端（Electron）的壳行为设置：机器级偏好，不随服务器切换、登出不清除。</p>
    </div>

    <div v-if="!isElectron" class="desktop-card">
      <p class="desktop-tip">当前为浏览器 / 安卓访问，无桌面壳设置项。</p>
    </div>

    <template v-else>
      <div v-if="loading" class="desktop-card"><p class="desktop-tip">正在读取桌面偏好…</p></div>

      <template v-else>
        <!-- 关窗行为 -->
        <div class="desktop-card">
          <h2 class="card-title">关窗行为</h2>
          <el-radio-group v-model="form.closeToTray" :disabled="saving" @change="onCloseToTrayChange">
            <el-radio value="tray">最小化到托盘</el-radio>
            <el-radio value="quit">直接退出</el-radio>
          </el-radio-group>
          <p class="field-hint">
            选择「最小化到托盘」时，关闭窗口后应用驻留托盘，任务继续执行，完成 / 待审批 / 待提问会以系统通知提醒，点击通知可回到对应会话。
            选择「直接退出」时行为与旧版一致：关闭窗口即结束应用，<strong>退出后不再收到系统通知</strong>。
            Windows / Linux 上 Alt+F4 与右上角 X 都是「关闭窗口」：托盘模式下为隐藏，彻底退出请用托盘菜单或应用菜单「退出 Mao」。
          </p>
        </div>

        <!-- 全局快捷键 -->
        <div class="desktop-card">
          <h2 class="card-title">全局快捷键</h2>
          <p class="field-hint">任意位置唤起 / 隐藏 Mao 主窗口。被其他程序占用时注册会失败，请更换组合键。</p>
          <div class="shortcut-row">
            <el-input
              :model-value="form.globalShortcut ?? ''"
              placeholder="未设置（已关闭）"
              readonly
              class="shortcut-input"
              @focus="startRecording"
              @blur="stopRecording"
              @keydown="onRecordKeydown"
            />
            <el-button :disabled="saving" @click="clearShortcut">清除</el-button>
            <el-button v-if="!form.globalShortcut" :disabled="saving" @click="restoreDefaultShortcut">恢复默认</el-button>
          </div>
          <p v-if="recording" class="field-hint recording-hint">按下新的组合键（含 Ctrl / Alt / Shift / Cmd 至少一个）…按 Esc 取消。</p>
          <p v-if="shortcutError" class="field-error">{{ shortcutError }}</p>
          <p class="field-hint">默认 <code>Alt+Shift+M</code>。</p>
        </div>

        <!-- 开机自启 -->
        <div class="desktop-card">
          <h2 class="card-title">开机自启</h2>
          <div class="switch-row">
            <el-switch
              v-model="form.autoStart"
              :disabled="saving || !packaged"
              @change="onAutoStartChange"
            />
            <span v-if="!packaged" class="field-hint inline-hint">
              开发模式（未打包）下不可用：避免把开发用的 electron 二进制写进系统登录项
            </span>
          </div>
          <p class="field-hint">开机后以隐藏模式驻留托盘（配合「最小化到托盘」使用；选择「直接退出」时自启仍会打开窗口）。</p>
        </div>

        <!-- 系统通知 -->
        <div class="desktop-card">
          <h2 class="card-title">系统通知</h2>
          <p class="field-hint">
            任务完成 / 待审批 / 待提问等通知由桌面端主进程投递，窗口最小化或隐藏到托盘时也能收到。
            通知的开关与分类在「消息通知」设置中；macOS 系统通知授权被拒时这里会给出提示。
          </p>
          <div class="notify-row">
            <el-button :loading="testingNotify" @click="sendTestNotify">发送测试通知</el-button>
            <span v-if="notifyResult" class="notify-result" :class="notifyResult.ok ? 'ok' : 'error'">
              {{ notifyResult.message }}
            </span>
          </div>
        </div>

        <!-- 本地附件目录 -->
        <div class="desktop-card">
          <h2 class="card-title">本地附件目录</h2>
          <p class="field-hint">
            LOCAL 模式下发送的非图片文件会复制到本机
            <code>~/.mao/attachments/&lt;服务器host&gt;/&lt;会话id&gt;/</code>
            （按服务器与会话隔离，文件不出本机，Agent 通过消息中的绝对路径读取）。
            目录在用户主目录下，项目工作区内无任何写入；更换服务器地址形态（域名 ↔ IP、http/https）后旧附件按新 host 隔离，不随迁。
          </p>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { isElectronClient } from '../../utils/platform'
import type { DesktopPrefs } from '../../types/desktop'

const isElectron = isElectronClient()

const loading = ref(true)
const saving = ref(false)
const packaged = ref(false)
const recording = ref(false)
const shortcutError = ref('')
const testingNotify = ref(false)
const notifyResult = ref<{ ok: boolean; message: string } | null>(null)

const form = reactive<{
  closeToTray: DesktopPrefs['closeToTray']
  globalShortcut: string | null
  autoStart: boolean
}>({
  closeToTray: 'tray',
  globalShortcut: 'Alt+Shift+M',
  autoStart: false,
})

function prefsApi() {
  return (window as any).electronAPI
}

async function load() {
  const api = prefsApi()
  if (!api?.desktopPrefsGet) return
  loading.value = true
  try {
    const result = await api.desktopPrefsGet()
    form.closeToTray = result.prefs.closeToTray === 'quit' ? 'quit' : 'tray'
    form.globalShortcut = result.prefs.globalShortcut ?? null
    form.autoStart = result.prefs.autoStart === true
    packaged.value = result.packaged === true
  } catch (e) {
    ElMessage.error((e as Error)?.message || '读取桌面偏好失败')
  } finally {
    loading.value = false
  }
}

async function onCloseToTrayChange(value: string | number | boolean) {
  const closeToTray = value === 'quit' ? 'quit' : 'tray'
  if (closeToTray === 'quit') {
    try {
      const { ElMessageBox } = await import('element-plus')
      await ElMessageBox.confirm(
        '切换为「直接退出」后，关闭窗口即结束应用，任务完成 / 待审批 / 待提问的系统通知将不再到达（应用未运行）。仍要切换吗？',
        '关窗行为',
        { confirmButtonText: '仍要切换', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      // 取消：还原单选态
      form.closeToTray = 'tray'
      return
    }
  }
  await savePrefs({ closeToTray })
}

async function onAutoStartChange(value: string | number | boolean) {
  await savePrefs({ autoStart: value === true })
}

async function savePrefs(patch: Partial<DesktopPrefs>) {
  const api = prefsApi()
  if (!api?.desktopPrefsSet) return
  saving.value = true
  try {
    const result = await api.desktopPrefsSet(patch)
    if (!result?.ok) {
      ElMessage.error(result?.error || '保存失败')
      await load()
      return
    }
    if (result.error) ElMessage.warning(result.error)
    // 以主进程返回的合并结果为准（dev 拒绝等场景下本地态可能被回绝）
    if (result.prefs) {
      form.closeToTray = result.prefs.closeToTray
      form.autoStart = result.prefs.autoStart === true
    }
  } catch (e) {
    ElMessage.error((e as Error)?.message || '保存失败')
    await load()
  } finally {
    saving.value = false
  }
}

// ─── 快捷键录制 ───

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

function startRecording() {
  recording.value = true
  shortcutError.value = ''
}

function stopRecording() {
  recording.value = false
}

/** 录制 keydown → Electron accelerator（如 Alt+Shift+M）；Esc 取消；纯修饰键忽略。 */
function onRecordKeydown(event: KeyboardEvent) {
  if (!recording.value) return
  event.preventDefault()
  if (event.key === 'Escape') {
    recording.value = false
    return
  }
  if (MODIFIER_KEYS.has(event.key)) return
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Cmd')
  if (parts.length === 0) {
    shortcutError.value = '请至少组合一个修饰键（Ctrl / Alt / Shift / Cmd）'
    return
  }
  const key = normalizeRecordedKey(event)
  if (!key) {
    shortcutError.value = '该按键无法作为全局快捷键'
    return
  }
  const accel = [...parts, key].join('+')
  recording.value = false
  void applyShortcut(accel)
}

function normalizeRecordedKey(event: KeyboardEvent): string | null {
  const key = event.key
  if (key.length === 1) return key.toUpperCase()
  // 功能键与命名键直接用 Electron 的 accelerator 名
  const named: Record<string, string> = {
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right',
  }
  return named[key] ?? null
}

async function applyShortcut(accel: string | null) {
  const api = prefsApi()
  if (!api?.desktopShortcutSet) return
  saving.value = true
  shortcutError.value = ''
  try {
    const result = await api.desktopShortcutSet(accel)
    if (result?.ok) {
      form.globalShortcut = result.prefs?.globalShortcut ?? accel
      ElMessage.success(accel ? `全局快捷键已设置为 ${accel}` : '已关闭全局快捷键')
    } else {
      shortcutError.value = result?.error || '快捷键设置失败'
    }
  } catch (e) {
    shortcutError.value = (e as Error)?.message || '快捷键设置失败'
  } finally {
    saving.value = false
  }
}

async function clearShortcut() {
  await applyShortcut(null)
}

async function restoreDefaultShortcut() {
  await applyShortcut('Alt+Shift+M')
}

// ─── 测试通知 ───

async function sendTestNotify() {
  const api = prefsApi()
  if (!api?.desktopNotify) return
  testingNotify.value = true
  notifyResult.value = null
  try {
    const result = await api.desktopNotify({
      title: 'Mao 测试通知',
      body: '如果你能看到这条通知，说明系统通知投递正常。',
      tag: 'mao-test-notify',
    })
    if (result?.ok) {
      notifyResult.value = { ok: true, message: '已发送，请查看系统通知中心' }
    } else {
      notifyResult.value = { ok: false, message: result?.error || '发送失败' }
    }
  } catch (e) {
    notifyResult.value = { ok: false, message: (e as Error)?.message || '发送失败' }
  } finally {
    testingNotify.value = false
  }
}

// ─── 主进程事件 ───

let disposeNotifyResult: (() => void) | null = null
let disposeShortcutFailed: (() => void) | null = null

onMounted(() => {
  void load()
  const api = prefsApi()
  if (api?.onDesktopNotifyResult) {
    disposeNotifyResult = api.onDesktopNotifyResult((data: { ok: boolean; error?: string }) => {
      if (data.ok) return
      notifyResult.value = { ok: false, message: data.error || '上次投递失败' }
    })
  }
  if (api?.onDesktopShortcutFailed) {
    disposeShortcutFailed = api.onDesktopShortcutFailed((data: { accel?: string; error?: string }) => {
      const accel = data.accel ? `（${data.accel}）` : ''
      shortcutError.value = `注册失败${accel}：${data.error || '可能被其他程序占用'}`
    })
  }
})

onBeforeUnmount(() => {
  disposeNotifyResult?.()
  disposeShortcutFailed?.()
})
</script>

<style scoped>
.desktop-page {
  max-width: 640px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 8px;
  color: var(--aw-ink);
  font-size: 20px;
  font-weight: 600;
}

.page-desc {
  margin: 0;
  color: var(--aw-ink-muted);
  font-size: 13px;
  line-height: 1.5;
}

.desktop-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-md);
  padding: 20px 24px;
  margin-bottom: 16px;
}

.card-title {
  margin: 0 0 12px;
  color: var(--aw-ink);
  font-size: 15px;
  font-weight: 600;
}

.field-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
}

.field-hint.inline-hint {
  display: inline;
  margin-left: 10px;
}

.field-hint code {
  background: var(--aw-surface-hover, rgba(0, 0, 0, 0.06));
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

.field-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--aw-danger, #c62828);
  line-height: 1.5;
}

.recording-hint {
  color: var(--aw-primary, #0066cc);
}

.shortcut-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.shortcut-input {
  width: 220px;
}

.switch-row {
  display: flex;
  align-items: center;
}

.notify-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.notify-result {
  font-size: 12px;
  line-height: 1.5;
}

.notify-result.ok {
  color: var(--aw-primary, #0066cc);
}

.notify-result.error {
  color: var(--aw-danger, #c62828);
}

.desktop-tip {
  font-size: 13px;
  color: var(--aw-ink-muted);
  line-height: 1.55;
  margin: 0;
}
</style>
