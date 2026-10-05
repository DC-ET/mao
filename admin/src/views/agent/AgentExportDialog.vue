<template>
  <el-dialog
    :model-value="true"
    title="导出 Agent Bundle"
    width="680px"
    :close-on-click-modal="false"
    @update:model-value="emit('close')"
  >
    <div v-loading="loading" class="export-body">
      <el-alert type="info" :closable="false" class="export-tip">
        导出包含 Agent 主体、经验、推荐问题、当前提示词与技能/MCP 引用；MCP 环境变量值将全量脱敏为
        <code>$MAO_REDACTED</code>，零密钥出包。勾选的用户技能可内联（文件随包携带），系统技能只能以引用方式导出。
      </el-alert>

      <template v-if="!skillLoadError">
        <div v-for="row in skillRows" :key="row.name" class="skill-row">
          <div class="skill-head">
            <span class="skill-name">{{ row.name }}</span>
            <el-tag v-if="row.kind === 'system'" type="info" size="small">系统技能 · 引用（不可内联）</el-tag>
            <el-tag v-else-if="row.kind === 'none'" type="warning" size="small">引用（目标实例需自行安装）</el-tag>
            <template v-if="row.kind === 'user' && row.partialConflict">
              <el-tooltip
                content="部分用户的个人技能中存在多个同名技能目录，这些归属不可内联；仅其余候选可勾选"
                placement="top"
              >
                <el-tag type="danger" size="small">部分归属同名冲突</el-tag>
              </el-tooltip>
            </template>
            <el-tooltip
              v-else-if="row.kind === 'conflict'"
              content="该用户的个人技能中存在多个同名技能目录，无法内联导出；请先在「技能管理」整理重名技能，或将该技能按引用方式导出"
              placement="top"
            >
              <el-tag type="danger" size="small">同名目录冲突 · 引用（不可内联）</el-tag>
            </el-tooltip>
          </div>
          <div v-if="row.kind === 'user'" class="skill-candidates">
            <el-checkbox
              v-for="candidate in row.candidates"
              :key="candidate.token"
              v-model="candidate.checked"
              :label="`内联（${candidate.ownerLabel}）`"
              @change="onCandidateChange(row, candidate)"
            />
          </div>
        </div>
      </template>
      <el-alert v-else type="warning" :closable="false">
        技能列表加载失败（{{ skillLoadError }}），本次将按全部引用方式导出。
      </el-alert>

      <div v-if="!hasSkillNames" class="no-skill">该 Agent 未绑定技能。</div>
    </div>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="exporting" @click="handleExport">导出 JSON</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AxiosResponse } from 'axios'
import { api } from '../../api'

const props = defineProps<{
  agent: { id: number; name: string; skillNames?: string[] | null }
}>()

const emit = defineEmits<{
  close: []
}>()

interface UserSkillItem {
  name: string
  userId: number
  username?: string | null
  displayName?: string | null
}

interface Candidate {
  token: string
  ownerLabel: string
  checked: boolean
}

interface SkillRow {
  name: string
  kind: 'system' | 'user' | 'none' | 'conflict'
  candidates: Candidate[]
  /** 部分归属用户存在同名多目录冲突（其余候选仍可内联） */
  partialConflict?: boolean
}

const loading = ref(false)
const exporting = ref(false)
const skillRows = ref<SkillRow[]>([])
const skillLoadError = ref('')

const hasSkillNames = computed(() => (props.agent.skillNames ?? []).length > 0)

onMounted(async () => {
  loading.value = true
  try {
    const [docs, userSkillsRes] = await Promise.allSettled([
      api.get('/skill-docs'),
      api.get('/admin/user-skills'),
    ])
    let systemNames = new Set<string>()
    if (docs.status === 'fulfilled') {
      systemNames = new Set(((docs.value.data ?? []) as Array<{ name?: string }>).map((d) => d.name ?? ''))
    }
    let userSkills: UserSkillItem[] = []
    if (userSkillsRes.status === 'fulfilled') {
      userSkills = (userSkillsRes.value.data ?? []) as UserSkillItem[]
    } else {
      skillLoadError.value = '需要 skill:read 权限'
    }

    // skillNames 可能因历史数据含重复项：按名去重（首个出现），避免同名多行触发多归属报错
    const seen = new Set<string>()
    skillRows.value = (props.agent.skillNames ?? [])
      .filter((name) => {
        if (seen.has(name)) return false
        seen.add(name)
        return true
      })
      .map((name) => {
      if (systemNames.has(name)) {
        return { name, kind: 'system' as const, candidates: [] }
      }
      const matches = userSkills.filter((s) => s.name === name)
      if (matches.length === 0) {
        return { name, kind: 'none' as const, candidates: [] }
      }
      // 同一用户存在多个同名（frontmatter）技能目录时该归属不可内联（后端会拒绝）；
      // 仅冲突用户占满候选时整行标记 conflict，否则保留其余用户候选并提示
      const perUserCount = new Map<number, number>()
      for (const s of matches) perUserCount.set(s.userId, (perUserCount.get(s.userId) ?? 0) + 1)
      const conflictedUsers = new Set(
        [...perUserCount.entries()].filter(([, n]) => n > 1).map(([u]) => u)
      )
      const selectable = matches.filter((s) => !conflictedUsers.has(s.userId))
      if (selectable.length === 0) {
        return { name, kind: 'conflict' as const, candidates: [] }
      }
      const partialConflict = conflictedUsers.size > 0
      return {
        name,
        kind: 'user' as const,
        partialConflict,
        // 唯一候选默认勾选；多候选由管理员自行选择归属
        candidates: selectable.map((s) => ({
          token: `${s.name}@${s.userId}`,
          ownerLabel: s.displayName || s.username || `用户#${s.userId}`,
          checked: selectable.length === 1 && !partialConflict,
        })),
      }
    })
  } finally {
    loading.value = false
  }
})
function collectInlineSkills(): string {
  const tokens: string[] = []
  for (const row of skillRows.value) {
    for (const candidate of row.candidates) {
      if (candidate.checked) tokens.push(candidate.token)
    }
  }
  return tokens.join(',')
}

// 同名技能的多个归属候选互斥（后端只接受一个 name@userId，勾第二个时取消其余）
function onCandidateChange(row: SkillRow, changed: Candidate) {
  if (!changed.checked) return
  for (const candidate of row.candidates) {
    if (candidate !== changed) candidate.checked = false
  }
}

async function handleExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const inlineSkills = collectInlineSkills()
    const resp = (await api.get(`/agents/${props.agent.id}/bundle`, {
      params: inlineSkills ? { inlineSkills } : undefined,
      responseType: 'blob',
      skipErrorToast: true,
      timeout: 120000,
    })) as unknown as AxiosResponse<Blob>
    // 失败响应无 Content-Disposition：blob 实为 fail JSON，解析后提示
    if (!resp.headers?.['content-disposition']) {
      let message = '导出失败'
      try {
        message = JSON.parse(await resp.data.text())?.message || message
      } catch { /* 保留默认提示 */ }
      ElMessage.error(message)
      return
    }
    const url = URL.createObjectURL(resp.data)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mao-agent-bundle-${props.agent.name}-v1.json`
    anchor.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出成功')
    emit('close')
  } catch {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.export-tip {
  margin-bottom: 16px;
}
.export-tip code {
  padding: 0 4px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.skill-row {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  margin-bottom: 10px;
}
.skill-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.skill-name {
  font-weight: 500;
}
.skill-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 8px;
}
.no-skill {
  color: var(--el-text-color-secondary);
  text-align: center;
  padding: 16px 0;
}
</style>
