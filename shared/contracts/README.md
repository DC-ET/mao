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

## 演进原则

- 新契约先确认「前后端语义完全一致」再下沉，避免把一端私有形状污染为公共契约。
- 命名以后端 VO 为准（后端是 API 真相源），前端适配时用别名或小范围改名。
