import { onActivated, reactive, ref, watch, type InjectionKey } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'

/**
 * 经验库管理页的状态与动作（技术方案 2026-11-13 §5.2）。
 *
 * 所有筛选/排序/分组/选中状态经 URL query 单向同步：UI 动作只写 URL（patchState），
 * route.query 变化统一在 applyQuery 中落地并触发加载——避免「动作改状态 + watch 再改」
 * 的自触发循环，也保证刷新/分享完整还原上下文（keep-alive LRU 逐出后同样可恢复）。
 */

export interface ExperienceDoc {
  fileName: string
  title: string
  keywords: string
  summary: string
  applicable: string
  lastVerified: string
  sizeBytes: number
  updatedAt: string
}

export interface LibraryOverviewEntry {
  agentId: number
  agentName: string
  enabled: boolean
  docCount: number
  totalBytes: number
  lastUpdatedAt: string
}

export interface OrphanEntry {
  agentId: number
  docCount: number
  totalBytes: number
  lastUpdatedAt: string
}

export interface KeywordFacet { tag: string; count: number }
export interface GroupCount { key: string; count: number }

export interface DocListResponse {
  enabled: boolean
  total: number
  page: number
  size: number
  docs: ExperienceDoc[]
  groupCounts: GroupCount[]
  keywords: KeywordFacet[]
}

export type SortField = 'fileName' | 'title' | 'updatedAt' | 'sizeBytes' | 'lastVerified'
export type SortOrder = 'asc' | 'desc'
export type GroupBy = 'none' | 'month' | 'keyword'
export type AbnormalFilter = '' | 'no-frontmatter' | 'no-title'

/** 右栏载荷：doc=单篇经验（file 入 URL）；index=索引（不入 URL）；create=新建（不入 URL）。 */
export interface ViewerPayload {
  kind: 'doc' | 'index' | 'create'
  fileName: string
  meta: ExperienceDoc | null
  content: string
  initialMode: 'render' | 'edit'
}

const SORT_FIELDS: readonly SortField[] = ['fileName', 'title', 'updatedAt', 'sizeBytes', 'lastVerified']
const ORDERS: readonly SortOrder[] = ['asc', 'desc']
const GROUP_BYS: readonly GroupBy[] = ['none', 'month', 'keyword']
const ABNORMALS: readonly AbnormalFilter[] = ['', 'no-frontmatter', 'no-title']
export const PAGE_SIZE = 20

/** 新建经验的 frontmatter 模板（正文占位防「空内容」拦截）。 */
function createTemplate(): string {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `---\ntitle: \nkeywords: \nsummary: \napplicable: \nlast_verified: ${today}\n---\n\n`
}

interface QueryState {
  agentId: number | null
  file: string
  page: number
  keyword: string
  tag: string
  verifiedFrom: string
  verifiedTo: string
  updatedFrom: string
  updatedTo: string
  abnormal: AbnormalFilter
  sort: SortField
  order: SortOrder
  groupBy: GroupBy
}

type LocationQuery = ReturnType<typeof useRoute>['query']

function parseQuery(q: LocationQuery): QueryState {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const int = (v: unknown, min: number): number | null => {
    const n = Number(v)
    return Number.isInteger(n) && n >= min ? n : null
  }
  const enumOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  return {
    agentId: int(q.agentId, 1),
    file: str(q.file),
    page: int(q.page, 1) ?? 1,
    keyword: str(q.keyword),
    tag: str(q.tag),
    verifiedFrom: str(q.verifiedFrom),
    verifiedTo: str(q.verifiedTo),
    updatedFrom: str(q.updatedFrom),
    updatedTo: str(q.updatedTo),
    abnormal: enumOf(q.abnormal, ABNORMALS, ''),
    sort: enumOf(q.sort, SORT_FIELDS, 'fileName'),
    order: enumOf(q.order, ORDERS, 'desc'),
    groupBy: enumOf(q.groupBy, GROUP_BYS, 'month'),
  }
}

function buildQuery(s: QueryState): Record<string, string> {
  const q: Record<string, string> = {}
  if (s.agentId != null) q.agentId = String(s.agentId)
  if (s.file !== '') q.file = s.file
  if (s.page > 1) q.page = String(s.page)
  if (s.keyword.trim() !== '') q.keyword = s.keyword.trim()
  if (s.tag !== '') q.tag = s.tag
  if (s.verifiedFrom !== '') q.verifiedFrom = s.verifiedFrom
  if (s.verifiedTo !== '') q.verifiedTo = s.verifiedTo
  if (s.updatedFrom !== '') q.updatedFrom = s.updatedFrom
  if (s.updatedTo !== '') q.updatedTo = s.updatedTo
  if (s.abnormal !== '') q.abnormal = s.abnormal
  if (s.sort !== 'fileName') q.sort = s.sort
  if (s.order !== 'desc') q.order = s.order
  if (s.groupBy !== 'month') q.groupBy = s.groupBy
  return q
}

export function useExperienceLibrary() {
  const route = useRoute()
  const router = useRouter()

  const overviewLoading = ref(false)
  const libraries = ref<LibraryOverviewEntry[]>([])
  const orphans = ref<OrphanEntry[]>([])
  const selectedAgentId = ref<number | null>(null)

  const enabled = ref(true)
  const docs = ref<ExperienceDoc[]>([])
  const total = ref(0)
  const page = ref(1)
  const groupCounts = ref<GroupCount[]>([])
  const keywordFacets = ref<KeywordFacet[]>([])
  const listLoading = ref(false)

  const keyword = ref('')
  const tag = ref('')
  const verifiedRange = ref<[string, string] | null>(null)
  const updatedRange = ref<[string, string] | null>(null)
  const abnormal = ref<AbnormalFilter>('')
  const sort = ref<SortField>('fileName')
  const order = ref<SortOrder>('desc')
  const groupBy = ref<GroupBy>('month')

  const viewer = ref<ViewerPayload | null>(null)
  const viewerLoading = ref(false)
  const rebuilding = ref(false)
  const toggling = ref(false)
  /** URL 中 file 参数的最新已落地值：diff 基准。不用 viewer 兼任——index/create 视图不下 URL，
   * 若拿 viewer 反推 file，任何 patchState 都会把 URL 里的 file 静默剥掉（技术方案 §3.5）。 */
  const appliedFile = ref('')
  /** 行内「编辑」按钮的临时意图：openDocContent 打开时套用，用完即复位（不入 URL）。 */
  let pendingEditMode: 'render' | 'edit' = 'render'

  function viewerFile(): string {
    return viewer.value?.kind === 'doc' ? viewer.value.fileName : ''
  }

  function currentState(): QueryState {
    return {
      agentId: selectedAgentId.value,
      file: appliedFile.value,
      page: page.value,
      keyword: keyword.value,
      tag: tag.value,
      verifiedFrom: verifiedRange.value?.[0] ?? '',
      verifiedTo: verifiedRange.value?.[1] ?? '',
      updatedFrom: updatedRange.value?.[0] ?? '',
      updatedTo: updatedRange.value?.[1] ?? '',
      abnormal: abnormal.value,
      sort: sort.value,
      order: order.value,
      groupBy: groupBy.value,
    }
  }

  let lastQuerySig = ''

  /** UI 动作统一入口：合并 patch 写 URL，状态落地与加载交给 route watcher（applyQuery）。 */
  function patchState(patch: Partial<QueryState>): void {
    const next = buildQuery({ ...currentState(), ...patch })
    const sig = JSON.stringify(next)
    if (sig === lastQuerySig) return
    lastQuerySig = sig
    void router.replace({ query: next })
  }

  async function loadOverview(): Promise<void> {
    overviewLoading.value = true
    try {
      const { data } = await api.get<{ libraries: LibraryOverviewEntry[]; orphans: OrphanEntry[] }>(
        '/agents/experience-library/overview',
      )
      libraries.value = data.libraries
      orphans.value = data.orphans
      // 首次进入且 URL 未指定库：默认选中第一个库
      if (selectedAgentId.value == null && data.libraries.length > 0) {
        patchState({ agentId: data.libraries[0].agentId })
      }
    } catch {
      // 拦截器已弹错误提示
    } finally {
      overviewLoading.value = false
    }
  }

  async function loadDocs(): Promise<void> {
    if (selectedAgentId.value == null) {
      docs.value = []
      total.value = 0
      groupCounts.value = []
      keywordFacets.value = []
      enabled.value = true
      return
    }
    listLoading.value = true
    try {
      const { data } = await api.get<DocListResponse>(
        `/agents/${selectedAgentId.value}/experience-library/docs`,
        {
          params: {
            page: page.value,
            size: PAGE_SIZE,
            sort: sort.value,
            order: order.value,
            groupBy: groupBy.value,
            ...(keyword.value.trim() !== '' ? { keyword: keyword.value.trim() } : {}),
            ...(tag.value !== '' ? { tag: tag.value } : {}),
            ...(verifiedRange.value ? { verifiedFrom: verifiedRange.value[0], verifiedTo: verifiedRange.value[1] } : {}),
            ...(updatedRange.value ? { updatedFrom: updatedRange.value[0], updatedTo: updatedRange.value[1] } : {}),
            ...(abnormal.value !== '' ? { abnormal: abnormal.value } : {}),
          },
        },
      )
      enabled.value = data.enabled
      docs.value = data.docs
      total.value = data.total
      groupCounts.value = data.groupCounts
      keywordFacets.value = data.keywords
    } catch {
      // 拦截器已弹错误提示（如库目录不存在）；列表保持空态
    } finally {
      listLoading.value = false
    }
  }

  async function openDocContent(fileName: string): Promise<void> {
    if (selectedAgentId.value == null) return
    viewerLoading.value = true
    try {
      const { data } = await api.get<{ fileName: string; content: string }>(
        `/agents/${selectedAgentId.value}/experience-library/docs/content`,
        { params: { file: fileName } },
      )
      const meta = docs.value.find((doc) => doc.fileName === fileName) ?? null
      viewer.value = { kind: 'doc', fileName: data.fileName, meta, content: data.content, initialMode: pendingEditMode }
    } catch {
      // 直达 URL 指向已删文档等场景：拦截器统一 toast，右栏回默认态并移除 file（技术方案 §3.5）
      viewer.value = null
      patchState({ file: '' })
    } finally {
      viewerLoading.value = false
      pendingEditMode = 'render'
    }
  }

  async function openIndex(): Promise<void> {
    if (selectedAgentId.value == null) return
    viewerLoading.value = true
    try {
      const { data } = await api.get<{ fileName: string; content: string; docCount: number }>(
        `/agents/${selectedAgentId.value}/experience-library/index`,
      )
      viewer.value = { kind: 'index', fileName: data.fileName, meta: null, content: data.content, initialMode: 'render' }
    } catch {
      // 拦截器已弹错误提示
    } finally {
      viewerLoading.value = false
    }
  }

  function openCreate(): void {
    viewer.value = { kind: 'create', fileName: '', meta: null, content: createTemplate(), initialMode: 'edit' }
  }

  /** route.query 单一落地口：diff 出需要刷新的部分，避免文档浏览类导航重复拉列表。 */
  async function applyQuery(next: QueryState): Promise<void> {
    const prevAgent = selectedAgentId.value
    const agentChanged = next.agentId !== prevAgent
    const fileChanged = next.file !== appliedFile.value
    const listChanged =
      agentChanged ||
      next.page !== page.value ||
      next.keyword !== keyword.value ||
      next.tag !== tag.value ||
      next.verifiedFrom !== (verifiedRange.value?.[0] ?? '') ||
      next.verifiedTo !== (verifiedRange.value?.[1] ?? '') ||
      next.updatedFrom !== (updatedRange.value?.[0] ?? '') ||
      next.updatedTo !== (updatedRange.value?.[1] ?? '') ||
      next.abnormal !== abnormal.value ||
      next.sort !== sort.value ||
      next.order !== order.value ||
      next.groupBy !== groupBy.value

    selectedAgentId.value = next.agentId
    page.value = next.page
    keyword.value = next.keyword
    tag.value = next.tag
    verifiedRange.value = next.verifiedFrom !== '' || next.verifiedTo !== '' ? [next.verifiedFrom, next.verifiedTo] : null
    updatedRange.value = next.updatedFrom !== '' || next.updatedTo !== '' ? [next.updatedFrom, next.updatedTo] : null
    abnormal.value = next.abnormal
    sort.value = next.sort
    order.value = next.order
    groupBy.value = next.groupBy
    appliedFile.value = next.file

    // 换库后旧库的右栏内容（文档/索引/新建草稿）全部失效
    if (agentChanged) viewer.value = null
    if (listChanged) await loadDocs()
    if (next.file !== '' && (fileChanged || agentChanged)) {
      await openDocContent(next.file)
    } else if (fileChanged && next.file === '' && viewer.value?.kind === 'doc') {
      // URL 摘除 file（关闭/删除已打开文档）：只收起文档视图，不影响不入 URL 的索引/新建视图
      viewer.value = null
    }
  }

  watch(() => route.query, (q) => {
    // 仅在本路由生效：keep-alive 下导航离开时 route.query 是目标页的，不能拿来做经验页状态
    if (route.name !== 'ExperienceLibrary') return
    // 本页动作写的 URL（patchState 已登记 sig）也必须落地状态——动作只写 URL 不改状态，
    // 落地统一在这里；applyQuery 不再写 URL（loadDocs 失败清理等除外），无自触发循环。
    // 登记当前 URL 的 sig：外部导航（如 Agent 列表页跳入）也保持 lastQuerySig 与 URL 一致，
    // 避免 patchState 的去重比对误判
    lastQuerySig = JSON.stringify(buildQuery(parseQuery(q)))
    void applyQuery(parseQuery(q))
  }, { immediate: true })

  void loadOverview()

  let firstActivation = true
  onActivated(() => {
    if (firstActivation) {
      firstActivation = false
      return
    }
    // keep-alive 复活：轻刷新计数与列表（筛选状态经 query/refs 保留）
    void loadOverview()
    void loadDocs()
  })

  const store = reactive({
    overviewLoading,
    libraries,
    orphans,
    selectedAgentId,
    enabled,
    docs,
    total,
    page,
    pageSize: PAGE_SIZE,
    groupCounts,
    keywordFacets,
    listLoading,
    keyword,
    tag,
    verifiedRange,
    updatedRange,
    abnormal,
    sort,
    order,
    groupBy,
    viewer,
    viewerLoading,
    rebuilding,
    toggling,

    selectAgent(agentId: number): void {
      patchState({ agentId, page: 1, file: '' })
    },
    search(text: string): void {
      patchState({ keyword: text, page: 1 })
    },
    setTag(value: string): void {
      patchState({ tag: value, page: 1 })
    },
    setVerifiedRange(range: [string, string] | null): void {
      patchState({
        verifiedFrom: range?.[0] ?? '',
        verifiedTo: range?.[1] ?? '',
        page: 1,
      })
    },
    setUpdatedRange(range: [string, string] | null): void {
      patchState({
        updatedFrom: range?.[0] ?? '',
        updatedTo: range?.[1] ?? '',
        page: 1,
      })
    },
    setAbnormal(value: AbnormalFilter): void {
      patchState({ abnormal: value, page: 1 })
    },
    setSort(value: SortField): void {
      patchState({ sort: value, page: 1 })
    },
    toggleOrder(): void {
      patchState({ order: order.value === 'desc' ? 'asc' : 'desc', page: 1 })
    },
    setGroupBy(value: GroupBy): void {
      patchState({ groupBy: value })
    },
    resetFilters(): void {
      patchState({
        keyword: '',
        tag: '',
        verifiedFrom: '',
        verifiedTo: '',
        updatedFrom: '',
        updatedTo: '',
        abnormal: '',
        sort: 'fileName',
        order: 'desc',
        groupBy: 'month',
        page: 1,
      })
    },
    turnPage(value: number): void {
      patchState({ page: value })
    },
    /** @param mode 行内「编辑」入口请求的初始视图态；同文档已打开时就地切换。 */
    openDoc(fileName: string, mode: 'render' | 'edit' = 'render'): void {
      if (viewer.value?.kind === 'doc' && viewer.value.fileName === fileName) {
        viewer.value = { ...viewer.value, initialMode: mode }
        return
      }
      pendingEditMode = mode
      if (appliedFile.value === fileName && viewer.value?.kind !== 'doc') {
        // URL file 已指向该文档但当前是索引/新建视图（patchState 会因 sig 相同被去重）：直接切回文档视图
        void openDocContent(fileName)
        return
      }
      patchState({ file: fileName })
    },
    openIndex,
    openCreate,
    closeViewer(): void {
      patchState({ file: '' })
      // create/index 不入 URL：直接收起
      if (viewer.value?.kind !== 'doc') viewer.value = null
    },
    async saveDoc(fileName: string, content: string, existing: boolean): Promise<boolean> {
      if (selectedAgentId.value == null) return false
      // 新建撞名 = 后端 PUT 无条件 upsert（整文件静默覆盖共享文档）：先探测存在再二次确认。
      // 探测请求 skipErrorToast：404 是预期分支，不弹「经验文档不存在」
      if (!existing) {
        let exists = false
        try {
          await api.get(`/agents/${selectedAgentId.value}/experience-library/docs/content`, {
            params: { file: fileName },
            skipErrorToast: true,
          })
          exists = true
        } catch {
          exists = false
        }
        if (exists) {
          try {
            await ElMessageBox.confirm(
              `文件「${fileName}」已存在，保存将覆盖原文档且不可恢复，确定继续吗？`,
              '覆盖确认',
              { type: 'warning' },
            )
          } catch {
            return false
          }
        }
      }
      try {
        await api.put(`/agents/${selectedAgentId.value}/experience-library/docs/content`, { fileName, content })
      } catch {
        return false
      }
      ElMessage.success('已保存')
      await Promise.all([loadDocs(), loadOverview()])
      if (existing && viewerFile() === fileName) {
        await openDocContent(fileName)
      } else if (!existing) {
        patchState({ file: fileName })
      }
      return true
    },
    async deleteDoc(doc: ExperienceDoc): Promise<void> {
      if (selectedAgentId.value == null) return
      try {
        await ElMessageBox.confirm(`确定删除「${doc.title || doc.fileName}」吗？该操作不可恢复。`, '删除经验', { type: 'warning' })
      } catch {
        return
      }
      try {
        await api.delete(`/agents/${selectedAgentId.value}/experience-library/docs`, { params: { file: doc.fileName } })
        ElMessage.success('已删除')
        if (viewerFile() === doc.fileName) {
          patchState({ file: '' })
        }
        await Promise.all([loadDocs(), loadOverview()])
      } catch {
        // 拦截器已弹错误提示
      }
    },
    async rebuildIndex(): Promise<void> {
      if (selectedAgentId.value == null) return
      rebuilding.value = true
      try {
        await api.post(`/agents/${selectedAgentId.value}/experience-library/index/rebuild`)
        ElMessage.success('索引已重建')
        if (viewer.value?.kind === 'index') await openIndex()
      } catch {
        // 拦截器已弹错误提示
      } finally {
        rebuilding.value = false
      }
    },
    async toggleEnabled(next: boolean): Promise<void> {
      if (selectedAgentId.value == null) return
      toggling.value = true
      try {
        const { data } = await api.patch<{ enabled: boolean }>(
          `/agents/${selectedAgentId.value}/experience-library`,
          { enabled: next },
        )
        enabled.value = data.enabled
        const lib = libraries.value.find((item) => item.agentId === selectedAgentId.value)
        if (lib) lib.enabled = data.enabled
        ElMessage.success(data.enabled ? '已启用团队经验库' : '已停用团队经验库')
      } catch {
        // 失败保持原状态（el-switch 用 :model-value 受控渲染，无需回滚）
      } finally {
        toggling.value = false
      }
    },
    reloadAll(): void {
      void loadOverview()
      void loadDocs()
    },
  })

  return store
}

export type ExperienceLibraryStore = ReturnType<typeof useExperienceLibrary>

export const EXPERIENCE_LIBRARY_KEY: InjectionKey<ExperienceLibraryStore> = Symbol('experience-library')
