# @mao/contracts

前后端共享的类型契约包。目标是在 TypeScript 全栈（后端 NestJS + 前端 Vue）之间消除重复定义、防止 API 契约漂移。

## 约定

1. **只放纯类型**：`interface` / `type` / `enum`（以及必要的字面量联合类型）。禁止放运行时逻辑（工厂函数、校验函数、类、实例等）。
2. **不下沉内部实现**：数据库实体（Row）、Repository/Service 接口、LlmAdapter 等内部抽象、前端 UI 视图模型（含交互状态如 `isExpanded`）都不放这里。
3. **契约以 REST API 边界为准**：请求体 / 响应体 / 跨端枚举 / 分页结构。

## 使用方式

### 后端

在对应领域 `types.ts` 中删除本地重复定义，改从本包 re-export，保持既有 `./types.js` import 路径不变：

```ts
export type { UserInfoVO, LoginVO } from '@mao/contracts';
```

### 前端

直接消费，避免重复定义：

```ts
import type { NotificationChannel } from '@mao/contracts';
```

## Agent 头像

- `POST /api/v1/agents/avatar`：登录并拥有 `agent:write`，multipart/form-data，仅一个 `file` 字段。
- 接受内容与 MIME 一致的 PNG、JPEG、WebP，原文件最大 2 MiB，单边最大 4096 像素；拒绝 SVG、动画和解码失败图片。
- 后端完整解码并移除元数据，缩放至 512 × 512 范围后重新编码为 PNG，复用通用上传存储和文件记录。返回 `Result<AgentAvatarUploadVO>`，例如 `{ code: 0, data: { avatarUrl: "/uploads/<uuid>.png" } }`。
- 上传不修改 Agent，可先上传再创建。Agent 创建/更新接受 `avatarUrl`，列表/详情返回该字段；省略更新字段保留原头像，`null` 清空。仅接受上传格式的同源 PNG 路径，禁止远程 URL、data URL 和 SVG。
- 头像是公开展示资源，不应上传敏感内容；替换或删除 Agent 不自动删除旧文件，沿用通用文件管理机制。
- 部署后端时执行迁移 `V105__agent_avatar_url.sql`。

- SSO 换票响应：`SsoExchangeVO`（accessToken、expiresIn、expiresAt、refreshAfter、user）。
- WS 在线换票：客户端发送顶层 `auth_refresh`（requestId、token），服务端返回顶层 `auth_refreshed`（requestId、expiresAt）；requestId 用于幂等确认，不广播 token。
- SDK 公司 SSO 模式与传统 `getToken` 模式互斥，凭证仅内存保存，支持主动续期、single-flight、有限重试及账号切换隔离。


- 新契约先确认「前后端语义完全一致」再下沉，避免把一端私有形状污染为公共契约。
- 命名以后端 VO 为准（后端是 API 真相源），前端适配时用别名或小范围改名。
