# 代码审查报告：feature/first-run-onboarding（首次成功体验）

- 审查对象：`feature/first-run-onboarding` 相对 `main` 的变更（ee79ae76 + 928d1415），涉及 backend-ts、admin、desktop、shared/contracts 与文档
- 审查日期：2026-10-25
- 审查方式：全量 diff 走读 + 关键链路代码追踪；每个确认的 bug 均以可运行的测试用例复现（临时 spec，验证后未留在工作区，内容附于下文）
- 结论：**确认 3 个 bug**（1 个功能级、1 个交互级、1 个工程文件级），另附 4 条低风险观察

---

## 确认的 Bug

### Bug 1（中高）：向导完成后的新建态分支丢弃「所选 Agent」，首条任务会用默认 Agent 执行

- 位置：`desktop/src/views/task/TaskView.vue` `startSampleTask`（L266–282 附近），配合 `handleOnboardingComplete`（L245–255 附近）
- 现象：首启向导第一步强制用户选 Agent（`next()` 有守卫，不选无法继续），但最常见的完成路径（新用户落地即新建态）里，`payload.chosenAgentId` 只被送往后端落库（`chosen_agent_id` 记录字段），**从未应用到新建态 Composer 的 `newTaskAgentId`**：

```ts
async function startSampleTask(payload: { chosenAgentId: string | null; sampleText: string }) {
  const text = payload.sampleText.trim()
  if (!isNewTaskMode.value) {
    // 非新建态分支：navigateToNewTask({ agentId, executionMode: 'CLOUD' }) —— agentId 有被应用
    ...
    await navigateToNewTask(payload.chosenAgentId ? { agentId: payload.chosenAgentId, executionMode: 'CLOUD' } : undefined)
  } else if (text) {
    // 新建态分支（主路径）：只预填文案，chosenAgentId 被完全忽略
    chatPrefillInput.value?.(text)
  }
  ...
}
```

- 影响链路（代码走读已确认）：
  - 新用户首次进入 `TaskView` → `resolveInitialRoute()` → 无会话 → `enterNewTaskMode()` → `resolveNewTaskDefaults()` 自动把 `newTaskAgentId` 置为**默认 Agent**；
  - `ChatPanel.handleSend` 首发时 `agentId.value = newTaskAgentId.value`（ChatPanel.vue L668–669），首条任务用 `newTaskAgentId` 对应的 Agent 执行；
  - 向导完成后 `newTaskAgentId` 仍是默认 Agent，Composer 的 AgentChip 也显示默认 Agent。用户在向导里选的 Agent 与实际执行第一条任务的 Agent 不一致，违背「选择一个智能体开始」的需求语义。
  - 讽刺的是：仅在 `initialLoading` 尚未结束（就绪接口先于任务索引返回）的少见时序下走非新建态分支，agentId 才会被 `navigateToNewTask` 应用。
- 复现测试：`desktop/src/views/task/onboarding-prefill.bugcheck.test.ts`（内容见附录 A）。测试挂载真实 `TaskView`（stub 掉重子组件），走真实 `onMounted → readiness PENDING → OnboardingOverlay @complete` 流程，断言 `newTaskAgentId` 应变为向导所选 `2002`。**当前代码下断言失败：`expected '1001' to be '2002'`**，且前置断言（已进入新建态、向导已展示、完成标记已翻转为 DONE、覆盖层已关闭）全部通过，证明走的是真实完成链路而非测试误配。
- 修复建议：新建态分支同样应用所选 Agent——例如 `if (payload.chosenAgentId) { newTaskAgentId.value = String(payload.chosenAgentId) }`（与 ChatPanel `handleNewTaskAgentChange` 的写入语义一致），或统一走 `navigateToNewTask({ agentId, executionMode: 'CLOUD' })`（两种分支合并为一条路径）。

### Bug 2（低）：向导第一步未选 Agent 时「下一步」按钮的 disabled 绑定失效

- 位置：`desktop/src/components/onboarding/OnboardingOverlay.vue` L68 与 L100
- 现象：`:disabled="step === 1 && !selectedAgent"` 中 `selectedAgent` 是**函数引用**（`const selectedAgent = () => ...`），在模板里恒为真值，`!selectedAgent` 恒为 `false`——按钮永远不会禁用。应为 `!selectedAgent()`。
- 影响：未选 Agent 时按钮可点击但点了没反应（守卫在 `next()` 里：`if (step.value === 1 && !selectedAgentId.value) return`），无任何禁用反馈，用户会以为坏了。业务流程不会被打穿（无法在未选择时进入第二步），故定为交互缺陷而非流程缺陷。叠加观察 3 时（列表为空）该问题更明显。
- 复现测试：`desktop/src/components/onboarding/overlay-disable.bugcheck.test.ts`（内容见附录 B）。真实挂载 `OnboardingOverlay`（ElementPlus 插件），agents 非空但未选择，断言「下一步」按钮应有 `disabled` 属性。**当前代码下失败：`disabled` 属性为 undefined、无 `is-disabled` class**。
- 修复建议：改为 `:disabled="step === 1 && !selectedAgent()"`（或引入 `selectedAgentComputed`）。

### Bug 3（中，工程文件）：`desktop/package-lock.json` 提交了未解决的 git 合并冲突标记，文件不是合法 JSON

- 位置：`desktop/package-lock.json` L9–13（ee79ae76 提交引入）：

```
<<<<<<< HEAD
      "version": "0.0.346",
=======
      "version": "0.0.347",
>>>>>>> bf88b96a (feat: 首次成功体验——就绪横幅、首启向导与入门模板（0.0.347）)
```

- 证据：
  - `git grep -l '^<<<<<<< HEAD' -- ':!*.md'` 全仓仅此一个文件命中；
  - `python3 -c "json.load(...)"` 与 `node -e "JSON.parse(...)"` 均解析失败（非法 JSON）；
  - 在干净目录（拷贝该 package.json + package-lock.json）执行 `npm ci --dry-run` 退出码 1（npm 靠其冲突容忍解析器单边恢复后仍报 lock 不同步）。
- 影响评估：
  - 本地开发用的 `npm install` 会容忍并改写该文件、`npm run build` 不读 lockfile，所以当前 CI（admin/desktop build）侥幸能过；
  - 但任何按 `npm ci` 走的干净环境/工具链（以及严格解析 lockfile 的第三方工具、后续合并、renovate/dependabot 类机器人）都会在此文件上失败或静默取单边；版本字段（0.0.346/0.0.347）语义含糊。属于必须合并前清理的工程问题。
- 备注：经与 `main` 分支 lockfile 对照验证，`npm ci` 报的 `Missing: electron-builder-squirrel-windows...` 同步性错误在 main 上同样存在，属**历史遗留**，不是本分支引入；本分支引入的只是冲突标记。
- 修复建议：在 desktop 下重跑 `npm install` 重新生成 lockfile（version 应为 0.0.347）并提交；顺带可评估是否修复历史遗留的 squirrel-windows 同步性问题（可另开任务）。

---

## 低风险观察（未列为确认 bug，仅供加固参考）

1. `backend-ts/src/model/model.repository.ts` `countEnabledWithApiKey()` 未过滤 `model_type = 'text'`，而同文件 `findDefault()` / `countActiveTextExcept()` 均以 `model_type = 'text'` 为口径。极端配置下（实例只启用了带 API Key 的图片模型、无 text 模型），readiness 会判 `modelsConfigured > 0`，desktop 不出降级页、向导照常走，用户首条任务在模型解析时才失败。建议补上 `AND model_type = 'text'`。
2. `ReadinessService.completeOnboarding` 是「先查后插」，`user_onboarding_preference.user_id` 是主键，`MysqlUserOnboardingPreferenceRepository.insert` 为普通 INSERT。双击「开始任务 / 跳过引导」（按钮无 loading 防抖）并发提交时，后插一方会撞 `ER_DUP_ENTRY` 变 500。desktop 侧有 catch 兜底不致流程中断，但会留错误日志；建议 `INSERT IGNORE` 或 `ON DUPLICATE KEY UPDATE`（幂等语义不变）。
3. readiness 的 `agentsEnabled` 用 `selectList(null, false)`（不看 `client_visible`），desktop 向导列表用的是 `/agents?scope=client`。若实例启用的 Agent 全部 `client_visible=0`，会出现「readiness 判定可以走向导，但向导第一步网格永远显示『智能体列表加载中，请稍候…』」（文案也不准确，实为无可见 Agent）。低概率配置，且可跳过。
4. `admin/src/views/agent/AgentListView.vue` 模板下拉懒加载失败时 `templates=[]`，下拉会一直显示「加载中…」（disabled 项），无法区分失败与加载中，且因 `loadTemplatesOnce` 的 `length > 0` 早退条件，失败后再次展开会重试（行为尚可），仅文案误导。

---

## 已验证无问题的关键链路（供合并决策参考）

- **后端 readiness 语义**：`defaultPasswordChanged` 仅 `isAdmin=true` 返回真实值（种子账号缺失/hash 空/密码不匹配均按已改处理，`SEED_ADMIN_USER_ID=1` 与 V001 种子一致）；onboarding 四态判定与 PUT 幂等（有记录即不覆盖、字符串 agentId 宽容解析、非法归 null）——`readiness.routes.spec.ts` 9 个用例全绿。
- **AUTO_DONE 静默判定**：`session` 表 `deleted` 列由 V051 补齐，`existsByUserId` 合法；desktop 只在首条消息发送时才创建会话（`useChat.sendMessage` 内 `createSession`），新用户不会因浏览即产生会话历史而误判 AUTO_DONE。
- **desktop 草稿预填链路**：`draftStore.setDraft('new', { html, text, files })` 与 `DraftEntry` 形状一致；非新建态分支先写草稿再 `navigateToNewTask`，`ChatInput` 挂载/键切换时 `restoreDraft('new')` 可恢复；新建态分支 `chatPrefillInput` 注入 → ChatPanel setup 赋值 → `chatInputRef.insertText`（已 defineExpose）链路完整。
- **admin 模板链路**：`GET /v1/agent-templates` 仅要求登录（与同类用户级路由一致）；`handleCreateFromTemplate` 以 `mode='create'` + `agentData` 预填，`mapSuggestedQuestions` 用 `item.content` 与模板数据形状匹配，`defaultModelId=null` 后端允许；`AgentFormDialog` visible watch 的填充逻辑覆盖该路径。
- **admin 就绪横幅**：`api` 拦截器解包 Result 信封后 `{ data }` 取值正确；`/models`、`/agents` 路由存在；改密弹窗关闭触发 refreshKey 重查逻辑成立。
- **回归**：backend-ts 全量 4974 测试通过（436 文件）；desktop 全量 839 单测通过（97 文件）；`npm run build`（vue-tsc -b + vite build）desktop、admin 双双通过。

---

## 验证过程说明

- 临时验证 spec 共 2 个（另有 1 个调试文件），**验证后已全部移出工作区**（现存放于 /tmp/bugcheck-keep/），内容分别见附录 A/B；建议落点与改造方式如下：
  - Bug 1 用例 → `desktop/src/views/task/onboarding-agent-apply.test.ts`：修复后把末尾断言改为期望 `2002` 即由「复现失败」转为「回归守护」。
  - Bug 2 用例 → `desktop/src/components/onboarding/OnboardingOverlay.test.ts`：修复后期望按钮被禁用，可补充「选择后可点、点击无 Agent 时无跳步」断言。
  - 两个用例均需 devDependencies：`@vue/test-utils`、`happy-dom`（本次以 `npm install --no-save` 临时装入 node_modules，**未改 package.json / package-lock.json**；正式收录用例时请把两个依赖写入 devDependencies）。vitest 支持 per-file `// @vitest-environment happy-dom` pragma，无需改 vitest.config.ts。
- Bug 3 无需测试文件，证据为命令输出（git grep / JSON.parse / npm ci），已在上文给出。

---

## 附录 A：Bug 1 复现测试（onboarding-prefill.bugcheck.test.ts）

```ts
// @vitest-environment happy-dom
/**
 * 临时审查验证用例（bugcheck，验证后删除，不入库）：
 * 验证首启向导「开始任务」后所选 Agent 是否应用到新建态 Composer（newTaskAgentId）。
 * TaskView.startSampleTask 新建态分支只预填文案（chatPrefillInput），
 * 未把 payload.chosenAgentId 写入 newTaskAgentId —— 向导第一步的选择被丢弃。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const { apiMock } = vi.hoisted(() => {
  const noop = () => ({ use: () => {} })
  return {
    apiMock: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(),
      interceptors: { request: { use: () => {} }, response: { use: () => {} } },
      getUri: () => '', defaults: { headers: {} },
    },
  }
})

// mock axios.create：让真实 src/api 模块创建出的实例也是 apiMock，全模块共享
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const create = vi.fn(() => apiMock)
  const axiosDefault = (actual as { default?: Record<string, unknown> }).default ?? actual
  return { ...actual, default: { ...(axiosDefault as object), create }, create }
})

vi.mock('../../utils/auth-storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getToken: () => 'test-token' }
})

import TaskView from './TaskView.vue'
import OnboardingOverlay from '../../components/onboarding/OnboardingOverlay.vue'
import { useReadinessStore } from '../../stores/readiness'

describe('bugcheck: 首启向导所选 Agent 是否应用到新建态', () => {
  it('新建态完成向导后 newTaskAgentId 应变为向导所选 Agent（2002）', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/sessions/groups') return { data: { groups: [] } }
      if (url === '/readiness') {
        return { data: { defaultPasswordChanged: true, modelsConfigured: 3, agentsEnabled: 2, onboarding: 'PENDING' } }
      }
      if (url === '/agents') {
        return {
          data: [
            { id: 1001, name: '默认Agent', isDefault: true, enabled: true, description: '' },
            { id: 2002, name: '向导选择的Agent', enabled: true, description: '' },
          ],
        }
      }
      return { data: null }
    })
    apiMock.put.mockResolvedValue({ data: { ok: true } })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'Home', component: TaskView },
        { path: '/tasks/:sessionId', name: 'Task', component: TaskView },
      ],
    })
    await router.push('/')
    await router.isReady()

    const pinia = createPinia()
    setActivePinia(pinia)

    const wrapper = mount(TaskView, {
      global: {
        plugins: [pinia, router],
        stubs: {
          TaskIndexPanel: true,
          CenterTabBar: true,
          CenterTabContainer: true,
          TaskInspector: true,
          ReadinessPending: true,
          OnboardingOverlay: true,
        },
      },
    })
    await flushPromises()
    await new Promise(r => setTimeout(r, 80))
    await flushPromises()

    const vm = wrapper.vm as any
    // 前置：已进入新建态、向导已展示
    expect(vm.isNewTaskMode).toBe(true)
    const readiness = useReadinessStore()
    expect(readiness.loaded).toBe(true)
    expect(readiness.readiness?.onboarding).toBe('PENDING')
    expect(wrapper.findComponent({ name: 'OnboardingOverlay' }).exists()).toBe(true)
    // 初始 newTaskAgentId 已被 enterNewTaskMode 设为默认 Agent 1001
    expect(String(vm.newTaskAgentId)).toBe('1001')

    // 用户在向导第一步选择了 Agent 2002，第三步点「开始任务」
    wrapper.findComponent({ name: 'OnboardingOverlay' }).vm.$emit('complete', {
      chosenAgentId: '2002',
      sampleText: '搜一下本周 AI 领域的重要新闻，给我 5 条带来源的摘要',
    })
    await flushPromises()
    await flushPromises()

    // 完成标记已翻转、覆盖层关闭
    expect(readiness.readiness?.onboarding).toBe('DONE')
    expect(wrapper.findComponent({ name: 'OnboardingOverlay' }).exists()).toBe(false)

    // 断言（当前代码会失败）：所选 Agent 未应用到 Composer，仍是默认 Agent
    expect(String(vm.newTaskAgentId)).toBe('2002')
  })
})
```

运行结果（修复前）：`AssertionError: expected '1001' to be '2002'`（其余前置断言全部通过）。

## 附录 B：Bug 2 复现测试（overlay-disable.bugcheck.test.ts）

```ts
// @vitest-environment happy-dom
/**
 * 临时审查验证用例（bugcheck，验证后删除，不入库）：
 * OnboardingOverlay 第一步未选 Agent 时「下一步」按钮是否禁用。
 * 模板 :disabled="step === 1 && !selectedAgent" 中 selectedAgent 是函数（恒真），
 * 按钮永远不会被禁用；预期被禁用（点击无反应，无任何提示）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { apiMock } = vi.hoisted(() => {
  const noop = () => ({ use: () => {} })
  return {
    apiMock: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(),
      interceptors: { request: { use: () => {} }, response: { use: () => {} } },
      getUri: () => '', defaults: { headers: {} },
    },
  }
})

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const create = vi.fn(() => apiMock)
  const axiosDefault = (actual as { default?: Record<string, unknown> }).default ?? actual
  return { ...actual, default: { ...(axiosDefault as object), create }, create }
})

import ElementPlus from 'element-plus'
import OnboardingOverlay from './OnboardingOverlay.vue'

describe('bugcheck: 向导第一步未选 Agent 时「下一步」应禁用', () => {
  it('未选择 Agent 时下一步按钮 disabled 属性存在', async () => {
    const wrapper = mount(OnboardingOverlay, {
      props: { agents: [{ id: 1001, name: 'A', description: '' }] },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.vm.$nextTick()
    const nextBtn = wrapper.findAll('button').find(b => b.text().includes('下一步'))
    expect(nextBtn).toBeTruthy()
    // 预期（正确行为）：未选择时禁用 → disabled 属性存在
    expect(nextBtn!.attributes('disabled')).toBeDefined()
  })
})
```

运行结果（修复前）：`disabled` 属性为 undefined、无 `is-disabled` class，断言失败。
