# 快捷指令设计方案

## 1. 概述

在桌面端对话输入框中实现快捷指令功能，通过 `/` 符号触发，展开一个可筛选的指令列表，包含 Skill 和 Command 两种类型。选中后以 tag 标签形式插入输入框，发送时后端根据标记格式自动解析并注入实际内容。

### 1.1 术语定义

| 术语 | 说明 |
|------|------|
| **Skill** | 已有的技能知识文档，由 SKILL.md 文件定义，分为系统 Skill（Agent 关联）和用户 Skill（个人上传） |
| **Command** | 新增概念，用户可自定义的提示词模板，存储在数据库中，选中后以 tag 形式插入输入框 |

## 2. 数据模型

### 2.1 Command 表

新增数据库表 `user_command`，通过 MyBatis-Plus 管理：

```sql
CREATE TABLE user_command (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL COMMENT '所属用户 ID',
    name        VARCHAR(100) NOT NULL COMMENT '指令名称，同用户下唯一',
    content     TEXT         NOT NULL COMMENT '指令内容（提示词模板）',
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_name (user_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户快捷指令';
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 自增主键 |
| `user_id` | BIGINT | 所属用户 |
| `name` | VARCHAR(100) | 指令名称，同用户下唯一 |
| `content` | TEXT | 指令内容，即提示词模板正文 |

### 2.2 快捷指令列表项（统一视图）

前端展示时，Skill 和 Command 统一为 `QuickCommand` 类型：

```typescript
interface QuickCommand {
  type: 'skill' | 'command'  // 类型标识
  name: string               // 唯一名称
  description: string        // 一行描述（Skill 来自 SKILL.md frontmatter，Command 无此字段，留空）
}
```

### 2.3 输入框中的标记格式

两种指令在输入框中以不同颜色的 tag 展示，在文本传输时使用不同的标记格式：

| 类型 | 传输格式 | 示例 | tag 颜色 |
|------|----------|------|----------|
| Skill | `${skill_name}$` | `${code-review}$` | 蓝色 |
| Command | `#{command_name}#` | `#{commit}#` | 紫色 |

用户在输入框中看到的是带颜色的 tag 标签（显示 name），但底层 textarea 中存储的是纯文本标记格式。

## 3. 后端 API

### 3.1 Command CRUD

新增 `UserCommandController`，遵循项目既有 controller → service → entity → mapper 分层：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/user-commands` | 列出当前用户的所有 Command |
| GET | `/v1/user-commands/{name}` | 获取 Command 详情（含 content） |
| POST | `/v1/user-commands` | 创建 Command |
| PUT | `/v1/user-commands/{name}` | 更新 Command |
| DELETE | `/v1/user-commands/{name}` | 删除 Command |

**POST/PUT 请求体**：

```json
{
  "name": "commit",
  "content": "请根据以下 diff 内容，按照 Conventional Commits 规范生成 commit message。"
}
```

**GET `/v1/user-commands` 响应**：

```json
{
  "code": 0,
  "data": [
    { "name": "commit", "content": "请根据以下 diff 内容，按照 Conventional Commits 规范生成 commit message。" },
    { "name": "code-review", "content": "请按照以下清单审查代码：..." }
  ]
}
```

### 3.2 快捷指令列表聚合 API

新增聚合接口，一次返回当前 Agent 上下文中可用的所有快捷指令：

**GET `/v1/quick-commands?agentId={agentId}`**

响应：

```json
{
  "code": 0,
  "data": {
    "skills": [
      { "type": "skill", "name": "code-review", "description": "代码审查规范" },
      { "type": "skill", "name": "data-export-spec", "description": "数据导出中心接入规范" }
    ],
    "commands": [
      { "type": "command", "name": "commit", "description": "" },
      { "type": "command", "name": "pr", "description": "" }
    ]
  }
}
```

**数据来源**：
- `skills`：当前 Agent 关联的系统 Skill + 当前用户的所有个人 Skill（合并去重，用户 Skill 优先）
- `commands`：当前用户的所有 Command（从 `user_command` 表查询）

## 4. 消息发送与解析

### 4.1 前端发送

用户输入框中的内容包含纯文本和标记格式的混合文本，例如：

```
帮我审查这段代码 ${code-review}$，然后按 #{commit}# 的格式提交
```

前端直接将 textarea 中的文本作为消息内容通过 WebSocket 发送，不做额外处理。

### 4.2 后端解析与替换

后端接收到消息后，由 `PromptEngine` 负责解析标记格式并在用户消息上原地替换：

1. **Skill 替换**：匹配 `${...}$` 格式，验证 Skill 存在后，将标记原地替换为 `/skill_name` 字符串
2. **Command 替换**：匹配 `#{...}#` 格式，从 `user_command` 表查询对应 Command 的 content，将标记原地替换为 content 正文

**解析规则**：
- 正则：`\$\{([^}]+)\}\$` 匹配 Skill，`\#\{([^}]+)\}\#` 匹配 Command
- 同一消息中可包含多个标记，逐一替换
- 若标记对应的 Skill/Command 不存在，保留原始标记文本并在日志中记录警告
- 替换直接作用于用户消息本身（`messages.set(i, ...)`），不生成额外的 system message

### 4.3 前端回显

历史消息回显时，前端对消息文本进行反向解析：

1. 匹配 `${...}$` 格式，渲染为蓝色 tag 标签（显示 Skill name）
2. 匹配 `#{...}#` 格式，渲染为紫色 tag 标签（显示 Command name）

回显仅做视觉渲染，标记文本本身保留在 DOM 的 data 属性中以支持复制粘贴。

## 5. 前端设计

### 5.1 数据获取

在 ChatInput 组件中，当输入框获得焦点且尚未加载过快捷指令数据时，调用 `GET /v1/quick-commands` 获取列表，结果缓存在组件内部的 `ref` 中（同一次会话内不重复请求）。

### 5.2 触发与筛选逻辑

在 ChatInput 的 textarea 上监听 `input` 事件，检测输入内容：

1. **触发条件**：用户输入 `/` 且 `/` 前方为空白字符或位于行首
2. **筛选规则**：提取 `/` 之后到光标位置的文本作为关键词，对所有 QuickCommand 按 `name` 进行前缀匹配（大小写不敏感）
3. **关闭条件**：
   - 用户按下 `Escape` 键
   - 用户删除了 `/` 符号
   - 用户选择了某条指令
   - 用户点击列表外部区域
   - 输入内容中出现空格后跟非筛选内容（光标移出指令范围）

### 5.3 UI 组件

#### 5.3.1 指令面板（QuickCommandPanel）

新建组件 `src/components/chat/QuickCommandPanel.vue`，作为 ChatInput 的子组件。

**布局**：
- 定位在 textarea 上方（空间不足时改为下方），左对齐
- 最大高度 320px，超出时内部滚动
- 宽度与 textarea 一致

**内容结构**：
```
┌─────────────────────────────────────┐
│  Skills                             │
│  ┌─────────────────────────────────┐│
│  │ code-review    代码审查规范     ││
│  │ data-export    数据导出规范     ││
│  └─────────────────────────────────┘│
│  Commands                           │
│  ┌─────────────────────────────────┐│
│  │ commit                         ││
│  │ pr                             ││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

**交互**：
- 键盘上下箭头移动选中项（跨分组连续移动）
- `Enter` 键选中当前高亮项
- 鼠标悬停高亮，点击选中
- 选中项始终滚动到可视区域内

**空状态**：无匹配结果时显示"未找到匹配的指令"。

#### 5.3.2 定位方式

使用 CSS `position: absolute` 相对于 ChatInput 容器定位。面板固定在 textarea 顶部上方（`bottom: 100%`），不跟随光标位置移动。

### 5.4 选中后的行为

用户选中某条快捷指令后：

1. **清空触发文本**：删除从 `/` 到光标位置的触发文本（含 `/` 符号本身）
2. **插入标记**：根据类型将对应格式的标记文本插入到光标位置
   - Skill：`${skillName}$`
   - Command：`#{commandName}#`
3. **渲染 tag**：插入标记后，将其渲染为输入框内的可视 tag 标签
   - Skill tag：蓝色背景，显示 name
   - Command tag：紫色背景，显示 name
4. **关闭面板**
5. **保持焦点**在 textarea 上

### 5.5 输入框中 tag 的渲染方案

采用 textarea + overlay 叠加方案：

- 底层 textarea 负责实际文本编辑和光标管理
- 上层放置一个与 textarea 完全重叠的 div（pointer-events: none），负责将标记文本渲染为可视 tag
- textarea 自身设为透明文本（`color: transparent`），用户看到的是 overlay 层的渲染结果
- 用户编辑时，textarea 中操作的是纯文本标记格式（`${name}$` / `#{name}#`），overlay 同步更新渲染

### 5.6 历史消息中的 tag 渲染

消息气泡组件中，对 `content` 文本做正向解析，将标记格式替换为对应的 tag 组件：

```vue
<!-- 伪代码 -->
<span v-for="segment in parsedSegments">
  <span v-if="segment.type === 'text'">{{ segment.content }}</span>
  <QuickCommandTag v-else :type="segment.type" :name="segment.name" />
</span>
```

`QuickCommandTag` 组件接收 `type`（skill/command）和 `name`，按类型渲染为不同颜色的内联标签。

### 5.7 ChatInput 改动

修改文件：`src/components/chat/ChatInput.vue`

**新增内部状态**：

```typescript
const quickCommands = ref<{ skills: QuickCommand[], commands: QuickCommand[] }>({ skills: [], commands: [] })
const panelVisible = ref(false)
const panelFilter = ref('')
const selectedIndex = ref(0)
const commandsLoaded = ref(false)
```

**事件处理**：

在 textarea 的 `input` 事件处理中增加 `/` 检测逻辑。在 `keydown` 事件处理中增加面板打开时的上下箭头、Enter、Escape 处理。

### 5.8 指令管理抽屉（CommandDrawer）

参照 SkillDrawer 的模式，新增指令管理入口，用于用户创建、查看、编辑和删除个人指令。

#### 5.8.1 Composable

新建 `src/composables/useCommandDrawer.ts`，与 `useSkillDrawer` 结构一致：

```typescript
const visible = ref(false)

export function useCommandDrawer() {
  function open() { visible.value = true }
  function close() { visible.value = false }
  function toggle() { visible.value = !visible.value }
  return { visible, open, close, toggle }
}
```

#### 5.8.2 TopNav 入口

在 TopNav 右侧工具栏中，于「技能」按钮旁新增「指令」按钮：

```
[终端] [技能] [指令] [主题切换] [用户头像]
```

点击调用 `toggleCommandDrawer()`，图标使用闪电/命令相关 SVG。

#### 5.8.3 CommandDrawer 组件

新建 `src/components/command/CommandDrawer.vue`，使用 `<el-drawer>` 实现。

**布局**：
```
┌──────────────────────────────────────┐
│  我的指令                            │
│                                      │
│  创建和管理个人快捷指令。             │
│                                      │
│  [+ 新建指令]                        │
│                                      │
│  ┌──────────────────────────────────┐│
│  │ commit                   [编辑][删]│
│  │ Conventional Commits ...         ││
│  ├──────────────────────────────────┤│
│  │ pr                     [编辑][删]││
│  │ 生成 PR 描述 ...                 ││
│  └──────────────────────────────────┘│
└──────────────────────────────────────┘
```

**功能说明**：

| 操作 | 说明 |
|------|------|
| 列表展示 | 打开抽屉时调用 `GET /v1/user-commands` 加载列表，展示 name 和 content 前 100 字符预览 |
| 新建指令 | 点击「新建指令」按钮，弹出表单对话框（name 输入框 + content 多行文本框），提交调用 `POST /v1/user-commands` |
| 编辑指令 | 点击卡片上的编辑按钮，弹出表单对话框（name 只读 + content 可编辑），提交调用 `PUT /v1/user-commands/{name}` |
| 删除指令 | 点击删除按钮，二次确认后调用 `DELETE /v1/user-commands/{name}` |

**表单对话框**：使用 `<el-dialog>`，内含 `<el-form>`，字段：
- `name`：`<el-input>`，新建时可编辑，编辑时只读
- `content`：`<el-input type="textarea" :rows="8">`，必填

## 6. 涉及文件

### 6.1 新增文件

| 文件 | 说明 |
|------|------|
| `backend/.../command/entity/UserCommand.java` | Command 实体类 |
| `backend/.../command/mapper/UserCommandMapper.java` | MyBatis-Plus Mapper |
| `backend/.../command/service/UserCommandService.java` | Command 业务逻辑 |
| `backend/.../command/controller/UserCommandController.java` | Command CRUD API |
| `backend/.../command/controller/QuickCommandController.java` | 聚合查询 API |
| `backend/.../resources/db/migration/V039__add_user_command.sql` | 建表迁移 |
| `desktop/src/components/chat/QuickCommandPanel.vue` | 快捷指令面板组件 |
| `desktop/src/components/chat/QuickCommandTag.vue` | 指令 tag 渲染组件 |
| `desktop/src/components/command/CommandDrawer.vue` | 指令管理抽屉组件 |
| `desktop/src/composables/useCommandDrawer.ts` | 指令抽屉可见性 composable |
| `desktop/src/types/quick-command.ts` | QuickCommand 类型定义 |
| `desktop/src/utils/quick-command-parser.ts` | 标记格式解析工具 |

### 6.2 修改文件

| 文件 | 改动 |
|------|------|
| `desktop/src/components/chat/ChatInput.vue` | 增加 `/` 检测、面板渲染、tag overlay、选中插入逻辑 |
| `desktop/src/components/common/TopNav.vue` | 增加「指令」入口按钮，引入 useCommandDrawer |
| `backend/.../harness/core/PromptEngine.java` | 增加消息中 `${...}$` 和 `#{...}#` 的解析与原地替换 |
| `backend/.../skill/service/SkillLoader.java` | 供聚合 API 和 PromptEngine 查询系统 Skill |
| `backend/.../skill/service/UserSkillService.java` | 供聚合 API 和 PromptEngine 查询用户 Skill |

## 7. Skill 与 Command 的差异对比

| 维度 | Skill | Command |
|------|-------|---------|
| 数据来源 | 文件系统（SKILL.md） | 数据库表（user_command） |
| 包含字段 | name, description, body | name, content |
| 传输标记格式 | `${skill_name}$` | `#{command_name}#` |
| tag 颜色 | 蓝色 | 紫色 |
| 后端替换行为 | 验证 Skill 存在后，替换标记为 `/skill_name` | 从 user_command 表获取 content，替换标记为 content 正文 |
| 作用域 | 系统 Skill 按 Agent 关联过滤，用户 Skill 全局可用 | 仅当前用户可用 |
