# 代码审查报告：admin 能力关联 + HTTP 工具试运行/复制 UX（feature/admin-capability-linking-http-tool-ux）

- 日期：2026-11-03
- 审查对象：worktree `.worktrees/admin-capability-http-tool-ux` 下全部未提交改动（backend-ts/src/http-tool/*、admin/src/views/*、admin/src/composables/useAgentRelations.ts、admin/src/components/RelatedAgentsPopover.vue、Layout.vue；CHANGELOG/README 不在审查范围）
- 审查方式：人工逐行审读 + 运行既有测试 + 为每个疑似 bug 补充可运行验证用例（用例执行后已删除，全文见附录，未改动任何被审代码）
- 基线：`backend-ts npx vitest run src/http-tool` 54 通过；`admin npx vue-tsc -b --force` 无错误

## 结论

确认 2 个 bug，均在 admin 前端 `admin/src/views/agent/AgentListView.vue`（本次新增的「按默认模型筛选」与「?keyword= 预填」两个功能点）。后端 http-tool 改动（toolId 掩码回填、copyFromId 密文继承）未发现功能 bug。

---

## Bug 1：默认模型筛选「清除」后整个 Agent 列表被清空（显示 0 行）

**文件与位置**

- `admin/src/views/agent/AgentListView.vue:251` — `const modelFilter = ref<number | ''>('')`（注释明确 `'' = 不过滤`）
- `admin/src/views/agent/AgentListView.vue:306` — `if (modelFilter.value !== '') rows = rows.filter((row) => row.defaultModelId === modelFilter.value)`
- `admin/src/views/agent/AgentListView.vue:33-44` — 筛选下拉 `<el-select v-model="modelFilter" clearable ...>`
- 依赖事实：项目使用 element-plus 2.14.0（`admin/node_modules/element-plus`），其 clearable select 清空时发出的值是 `undefined` 而非 `''`（`es/hooks/use-empty-values/index.mjs` 中 `DEFAULT_VALUE_ON_CLEAR = void 0`；`es/components/select/src/useSelect.mjs:317` `const value = props.multiple ? [] : valueOnClear.value`）

**根因**

Element Plus 2.14 清空单选下拉时 `v-model` 被置为 `undefined`。守卫 `modelFilter.value !== ''` 对 `undefined` 判真（`undefined !== ''` 为 true），于是「清除筛选」被当成「按 `defaultModelId === undefined` 过滤」。后端 VO 的 `defaultModelId` 只会是 number 或 `null`，没有任何行能命中 `undefined`，结果 `matchedAgents` 恒为空数组，列表显示 0 行（桌面表格与移动卡片共用该 computed，同时受影响）。用户除重新选择一个模型或刷新页面外无法恢复列表。

**手工复现**

1. 打开「Agent 管理」页（存在至少 1 个 Agent）。
2. 在「默认模型」筛选下拉中选择任意模型 → 列表只剩该模型的 Agent（正常）。
3. 点击输入框内的清除（x）图标 → 下拉显示回占位符「全部」，但列表变为「暂无数据」（期望：清除筛选后显示全部 Agent）。

**验证用例（已实际运行，vitest + @vue/test-utils 2.5.1 + 真实 element-plus 组件 + happy-dom）**

挂载真实 AgentListView（mock `../../api` 与 `../../stores/auth`，用替身捕获 `el-table` 的 `:data`），通过真实 DOM 交互驱动：展开下拉点选模型 → hover 后点击 `.el-select__clear`。

```
断言序列：
1. 挂载后行数 = 2                                   ✓ 通过
2. 选中模型 gpt-x 后行数 = 1（alpha）                ✓ 通过
3. setupState.modelFilter === 5                     ✓ 通过
4. 点击清除后 setupState.modelFilter === undefined  ✓ 通过（且 !== ''，证实守卫失效路径）
5. 清除后行数应为 2                                  ✗ 失败，实际 0
   AssertionError: expected +0 to be 2 // Object.is equality
```

第 5 条断言失败即 bug 实锤：清除筛选后列表为 0 行而非 2 行。用例全文见附录。

**影响**：Agent 管理页新筛选功能的核心交互（清除）直接把页面置于空列表状态，属功能性回归级缺陷。

---

## Bug 2：`?keyword=` 预填仅在组件首次挂载生效，keep-alive 复活路径完全失效

**文件与位置**

- `admin/src/views/agent/AgentListView.vue:456-464` — `route.query.keyword` 只在 `onMounted` 中读取并写入 `searchQuery`
- `admin/src/views/agent/AgentListView.vue:466-474` — `onActivated` 仅调用 `loadNameDictionaries()/refreshAgentData()`，不读取 `route.query.keyword`
- `admin/src/components/Layout.vue:62-69` — `<keep-alive :max="8"><component :is="Component" :key="viewRoute.name === 'SessionDetail' ? viewRoute.fullPath : viewRoute.path" /></keep-alive>`（key 为 `viewRoute.path`，不含 query；`/agents` 路由 `meta.keepAlive: true`）
- 触发方：`admin/src/components/RelatedAgentsPopover.vue:30-32` — `goAgent()` 执行 `router.push({ path: '/agents', query: { keyword: agent.name } })`

**根因**

Agent 管理、模型管理、MCP、Skills、自定义工具页均被 `keep-alive` 缓存（key=`route.path`）。用户只要先访问过一次 Agent 管理页（常见路径），从模型/MCP/Skill/自定义工具列表的「关联 Agent」气泡点击某个 Agent 名跳转 `/agents?keyword=xxx` 时，router-view 复用缓存实例：`onMounted` 不再执行，仅触发 `onActivated`，而该钩子不读 query。结果：URL 带着 keyword，但 `searchQuery` 保持旧值，`onActivated` 里的 `refreshAgentData()` 用旧（空）关键字重新拉列表——气泡点名跳转这一主路径的过滤预填完全失效，且页面状态（全量列表）与 URL（带过滤）不一致。只有刷新/新开标签页这类首次挂载路径才生效。

**手工复现**

1. 打开「Agent 管理」页，随后切到「模型管理」页（Agent 管理组件进入 keep-alive 缓存）。
2. 在模型列表「关联 Agent」列 hover 数字，点击气泡中任一 Agent 名。
3. 跳转到 `/agents?keyword=<Agent名>`，但搜索框为空、列表未按名称过滤（期望：搜索框预填并按名称过滤）。

**验证用例（已实际运行，与 Bug 1 同套环境，真实 vue-router（memory history）+ keep-alive 宿主，宿主模板与 Layout.vue 的 `:key="route.path"` 写法一致）**

```
用例 A（复现）：
1. push('/agents') 首次挂载，记录 /agents 请求            ✓
2. push('/other') 离开（组件被 keep-alive 缓存）           ✓
3. push({ path:'/agents', query:{ keyword:'alpha' } }) 复活 ✓
4. router.currentRoute.query.keyword === 'alpha'          ✓ 通过（URL 确实带 keyword）
5. 复活后列表请求的 keyword 应为 'alpha'                    ✗ 失败，实际 ''
   AssertionError: expected '' to be 'alpha'
6. 搜索框 input.value 应为 'alpha'                         ✗ 失败（未预填）

用例 B（对照组，证明功能意图本身在首挂载路径是好的）：
直接以 '/agents?keyword=alpha' 首次挂载
→ 列表请求 keyword='alpha' ✓、搜索框预填 'alpha' ✓（通过）
```

对照组通过、复现用例失败，两者对照证明：`?keyword=` 预填功能只在首次挂载生效，keep-alive 复活路径（即气泡点名跳转的主要使用路径）失效。

**影响**：本次需求明确交付的「RelatedAgentsPopover 点名 → Agent 列表 ?keyword= 预填」在最常见的导航路径下不工作，并造成 URL 与页面内容不一致。

---

## 已检查且未发现问题的部分（简要）

- 后端 `http-tool.service.ts`：`resolveDraftHeaders` 的掩码判断先于键敏感性判断、`isSensitiveHeaderKey(key) && enc:` 前缀双条件解密，与 `encodeHeaders`/`decodeHeaders` 口径一致；`copyFromId` 源不存在抛 `HTTP_TOOL_NOT_FOUND`、掩码无法对应旧值抛 `PARAM_INVALID`；`update()` 忽略 `copyFromId` 与类型注释一致。`npx vitest run src/http-tool` 全部 54 用例通过。
- 后端路由 `optionalPositiveInt`（toolId/copyFromId）：未传 undefined、0/负数/小数/非数字均 400（PARAM_INVALID），路径 id 校验不受影响。
- `useAgentRelations`：API 形状核对无误（`/v1/agents`、`/v1/mcp-servers`、`/v1/models/active` 均返回数组；`/v1/admin/http-tools` 取 `data.records` 正确）；`parseIdList` 容错、`load()` 并发序号守卫、fail-soft 置空均正确。
- `HttpToolListView`：`testToolId` 三种来源（列表行 / 编辑弹窗 editingId / 复制弹窗 copySourceId）数据流闭环，弹窗关闭 `resetForm/resetTest` 均正确复位；复制名称 `_copy` 截断不超 64；掩码头在复制/编辑/列表测试三条路径下与后端解析源一致。
- 其余新列（Model/Mcp/Skill 的关联 Agent 列）、`RelatedAgentsPopover` 跳转目标 `/agents` 与路由表匹配、keyword 服务端 `name LIKE` 模糊匹配能命中整名。
- `Layout.vue` 删除未使用的 `canWrite` 后无残留引用（grep 为空），`vue-tsc -b --force` 通过。

## 附录：验证用例全文（复现方法）

环境：Node 22（`export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`）。

```bash
cd admin
npm i --no-save @vue/test-utils@2   # 仅装依赖，不改 package.json（验证后已卸载）
# 将下方用例保存为 admin/src/views/agent/zz-bugverify.spec.ts
npx vitest run src/views/agent/zz-bugverify.spec.ts
# 预期结果：3 个用例中 2 个失败（Bug1 断言 received 0；Bug2 断言 received ''），对照组通过
```

```ts
/**
 * 临时验证用例（审查用，验证后删除）：
 * Bug A — AgentListView 默认模型筛选 clearable select 清空后置为 undefined，
 *         `modelFilter.value !== ''` 判定失效 → matchedAgents 过滤出 0 行。
 * Bug B — RelatedAgentsPopover 直跳 /agents?keyword= 仅在 onMounted 预填；
 *         Layout.vue keep-alive（:key=viewRoute.path）下组件复用走 onActivated，
 *         keyword 被忽略。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import ElementPlus from 'element-plus'

const apiGet = vi.fn()
vi.mock('../../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  },
}))
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ hasPermission: () => true }),
}))

const agentsFixture: any[] = [
  {
    id: 1, name: 'alpha', description: '', avatarUrl: null, isDefault: false, enabled: true,
    clientVisible: true, experienceLibraryEnabled: true, defaultModelId: 5, creatorName: null,
    createdAt: null, experiences: [], suggestedQuestions: [], skillNames: [], mcpServerIds: [], httpToolIds: [],
  },
  {
    id: 2, name: 'beta', description: '', avatarUrl: null, isDefault: false, enabled: true,
    clientVisible: true, experienceLibraryEnabled: true, defaultModelId: null, creatorName: null,
    createdAt: null, experiences: [], suggestedQuestions: [], skillNames: [], mcpServerIds: [], httpToolIds: [],
  },
]

const agentCalls: any[] = []

beforeEach(() => {
  agentCalls.length = 0
  apiGet.mockReset()
  apiGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/agents') {
      const params = config?.params ?? {}
      agentCalls.push({ hasKeyword: 'keyword' in params, keyword: params.keyword })
      return Promise.resolve({ data: agentsFixture })
    }
    if (url === '/models/active') return Promise.resolve({ data: [{ id: 5, name: 'gpt-x' }] })
    if (url === '/mcp-servers') return Promise.resolve({ data: [] })
    if (url === '/admin/http-tools') return Promise.resolve({ data: { records: [], total: 0 } })
    return Promise.resolve({ data: undefined })
  })
})

afterEach(() => { document.body.innerHTML = '' })

/** fetchAgents 每次都带 keyword 键（可为 ''），fetchVisibilityAgents 不带 — 用键存在性区分。 */
function lastKeywordedCall() {
  return agentCalls.filter((c) => c.hasKeyword).at(-1)!
}

// 捕获 :data 的 el-table 替身（真实 el-table 在 happy-dom 下过重，行数据才是被测对象）
const seenRows: unknown[][] = []
const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: { data: { type: Array, default: () => [] } },
  watch: {
    data: {
      immediate: true,
      handler(rows: unknown[]) { seenRows.push([...(rows as unknown[])]) },
    },
  },
  template: '<div class="stub-table"><div v-for="r in data" :key="r.id" class="stub-row">{{ r.name }}</div></div>',
})

class RO { observe() {} unobserve() {} disconnect() {} }
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
}

const Host = defineComponent({
  template: `<router-view v-slot="{ Component, route }">
    <keep-alive :max="8"><component :is="Component" :key="route.path" /></keep-alive>
  </router-view>`,
})

async function flushAll() {
  await flushPromises()
  await nextTick()
  await nextTick()
}

describe('Bug A: 默认模型筛选 clear 后列表被清空', () => {
  it('选中模型 → 1 行；clear 该筛选 → 应回到 2 行（实际 0 行）', async () => {
    seenRows.length = 0
    const { default: AgentListView } = await import('./AgentListView.vue')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: defineComponent({ render: () => null }) }],
    })
    await router.push('/agents')
    await router.isReady()
    const wrapper: VueWrapper = mount(AgentListView, {
      global: { plugins: [ElementPlus, router], stubs: { ElTable: ElTableStub } },
      attachTo: document.body,
    })
    await flushAll()
    expect(seenRows.at(-1)!.length).toBe(2)

    const selects = wrapper.findAll('.el-select')
    expect(selects.length).toBeGreaterThanOrEqual(2)
    const modelSelect = selects[1]! // 第 2 个 = 默认模型（第 1 个是状态）

    await modelSelect.find('.el-select__wrapper').trigger('click')
    await flushAll()
    const optionEls = Array.from(document.body.querySelectorAll('.el-select-dropdown__item'))
    const target = optionEls.find((el) => (el.textContent || '').includes('gpt-x'))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAll()

    expect(seenRows.at(-1)!.length).toBe(1)
    expect((seenRows.at(-1)![0] as { name: string }).name).toBe('alpha')
    const setupState = (wrapper.vm.$ as any).setupState
    expect(setupState.modelFilter).toBe(5)

    // 清空（点击 clear 图标 → Element Plus 2.14 置 undefined）
    await modelSelect.trigger('mouseenter')
    await nextTick()
    const clearBtn = modelSelect.find('.el-select__clear')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushAll()

    expect(setupState.modelFilter).toBe(undefined)
    expect(setupState.modelFilter).not.toBe('')

    const afterClear = seenRows.at(-1)!.length
    expect(afterClear).toBe(2) // ← 实际为 0，用例失败即证明 bug 存在

    wrapper.unmount()
  })
})

describe('Bug B: ?keyword= 在 keep-alive 复活时被忽略', () => {
  it('先访问 /agents，再从 /other 带 ?keyword=alpha 回来 → 搜索框未预填、请求未带 keyword', async () => {
    seenRows.length = 0
    const { default: AgentListView } = await import('./AgentListView.vue')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/agents', component: AgentListView },
        { path: '/other', component: defineComponent({ template: '<div>other-page</div>' }) },
      ],
    })
    await router.push('/agents')
    await router.isReady()
    const wrapper = mount(Host, {
      global: { plugins: [ElementPlus, router], stubs: { ElTable: ElTableStub } },
      attachTo: document.body,
    })
    await flushAll()
    expect(agentCalls.length).toBeGreaterThan(0)

    await router.push('/other')
    await flushAll()
    await router.push({ path: '/agents', query: { keyword: 'alpha' } })
    await flushAll()

    expect(router.currentRoute.value.query.keyword).toBe('alpha')
    expect(lastKeywordedCall().keyword).toBe('alpha') // ← 实际 ''，用例失败即证明 bug 存在
    const input = wrapper.find('.search-form input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('alpha') // ← 实际 ''

    wrapper.unmount()
  })

  it('对照组：首次挂载（新页面/刷新）时 ?keyword= 会正常预填', async () => {
    seenRows.length = 0
    const { default: AgentListView } = await import('./AgentListView.vue')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/agents', component: AgentListView }],
    })
    await router.push({ path: '/agents', query: { keyword: 'alpha' } })
    await router.isReady()
    const wrapper = mount(Host, {
      global: { plugins: [ElementPlus, router], stubs: { ElTable: ElTableStub } },
      attachTo: document.body,
    })
    await flushAll()
    expect(lastKeywordedCall().keyword).toBe('alpha') // 通过 → 证明功能仅在首挂载生效
    const input = wrapper.find('.search-form input')
    expect((input.element as HTMLInputElement).value).toBe('alpha')
    wrapper.unmount()
  })
})
```

实测输出（节选）：

```
× 选中模型 → 1 行；clear 该筛选 → 应回到 2 行（实际 0 行）
    AssertionError: expected +0 to be 2 // Object.is equality
× 先访问 /agents，再从 /other 带 ?keyword=alpha 回来 → 搜索框未预填、请求未带 keyword
    AssertionError: expected '' to be 'alpha' // Object.is equality
✓ 对照组：首次挂载（新页面/刷新）时 ?keyword= 会正常预填

Test Files  1 failed (1)     Tests  2 failed | 1 passed (3)
```

> 说明：验证用的 spec 文件与 `@vue/test-utils` 依赖在验证完成后均已移除，工作区保持与审查开始时一致（git status 仅含本次需求本身的改动）。

---

## 第 2 轮复审（2026-11-03）：修复验证 — 未发现新 bug

- 修复范围：仅 `admin/src/views/agent/AgentListView.vue`（其余改动与第 1 轮完全一致，git diff --stat 对比确认）。
  - Bug 1：`modelFilter` 放宽为 `ref<number | '' | undefined>('')`，守卫改为 `modelFilter.value != null && modelFilter.value !== ''`。
  - Bug 2：预填改为 `watch(() => route.query.keyword, ..., { immediate: true })`（keep-alive 复活与首次挂载均生效；空 query 不清空已输入搜索词；命中时重置页码并 fetchAgents）。

**验证方式**：重新以真实组件挂载（vitest 4.1.12 + @vue/test-utils 2.5.1 --no-save + 真实 element-plus 2.14.0 + 真实 vue-router keep-alive 宿主，宿主 `:key="route.path"` 与 Layout.vue 一致）执行 5 个场景用例，**全部通过**：

1. 选中模型 → 1 行；点击 `.el-select__clear` → `modelFilter===undefined` → 列表恢复 2 行（Bug 1 修复生效）。
2. `/agents` → `/other` → 带 `?keyword=alpha` 复活：搜索框预填 `alpha`、列表请求带 `keyword=alpha`（Bug 2 修复生效）。
3. 二次换词跳转（alpha → beta）：均正确预填与带词拉取。
4. 空 query 回到 `/agents`：已输入搜索词按设计保留并继续生效。
5. 首次挂载带 `?keyword=`（immediate 分支）：预填与带词拉取正常。

**修复代码本身的边界检查（均无问题）**：

- `route.query.keyword` 为数组（重复参数）或纯空白时 `typeof/trim` 守卫正确跳过。
- watch 回调在 keep-alive 失活状态下仍存活，理论上可被其它路由的 `?keyword=` 变化误触发；但全仓 grep 确认当前唯一生产者是 `RelatedAgentsPopover`（只跳 `/agents`），无触发路径，不构成 bug。
- watch 的 `fetchAgents` 与 `onActivated` 的 `refreshAgentData` 无论触发先后，`fetchAgentsSeq` 守卫 + 相同参数使最终状态收敛正确（场景 2/3 实测）。
- 筛选守卫对 `undefined`/`null`/`''` 三种空值均放行，数字与 VO 的 `defaultModelId`（number|null）严格相等比较正确。

**结论**：两处修复正确生效，探测的回归场景（换词二次跳转、空 query 语义、首次挂载）均符合设计声明；全量未提交改动（含后端 http-tool）本轮未发现新的功能 bug。验证用 spec 与临时依赖已移除，`admin npx vue-tsc -b --force` 复验通过。
