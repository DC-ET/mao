# 个人信息页 + 头像上传 技术方案

> 状态：方案已确认，待评审后进入开发
> 版本：v0.1 | 日期：2026-08-06
> 范围：桌面端（Electron / Web / 安卓 WebView 复用同一前端）

---

## 1. 需求背景

桌面客户端设置页目前只有 Git 凭证、消息通知、微信 Bot、MCP 服务器、定时任务五项，**缺少用户自己的个人信息管理入口**；顶栏用户区域显示的是固定的占位图标，**不展示真实头像**。

系统数据基础已经具备：`user` 表自 V001 起就有 `avatar_url`、`display_name`、`email` 字段，后端 `GET /v1/users/me` 也已返回这些字段。缺口在于：

- 没有「当前用户自助更新资料」的后端接口（现有 `PUT /v1/users/{id}` 是管理员接口，需要 `user:write` 权限）
- 桌面端没有个人信息页面
- 顶栏不显示真实头像

本次需求：在桌面端设置页新增「个人信息」子页，支持上传 / 移除头像，并允许修改个人资料（显示名称、邮箱）。

## 2. 需求描述

### 2.1 页面结构

在桌面端设置页 `/settings` 下新增子路由 `/settings/profile`（「个人信息」），作为设置页的**默认首页**。页面包含两个区块：

**头像区**
- 大尺寸圆形头像预览（96px，`el-avatar`）
- 「更换头像」：选择图片 → 本地预览 → 点击「保存」统一提交
- 「移除头像」：`avatar_url` 非空时显示，点击后置空并恢复默认占位
- 校验规则：仅允许 `jpg / png / webp`，单文件 ≤ 5MB，不做前端裁剪

**资料区**
| 字段 | 展示 | 可编辑 | 说明 |
|------|------|--------|------|
| 用户名 | 只读文本 | 否 | 登录名，不可修改 |
| 显示名称 | 文本输入框 | 是（仅 LOCAL 用户） | LDAP / 飞书用户禁用 |
| 邮箱 | 文本输入框 | 是（仅 LOCAL 用户） | LDAP / 飞书用户禁用 |
| 登录方式 | 只读标签 | 否 | LOCAL / LDAP / 飞书 |

「保存」按钮统一提交头像 + 资料字段。

### 2.2 入口

1. 设置页侧边栏顶部新增「个人信息」项（置顶于 Git 凭证之前）
2. `/settings` 默认重定向从 `git-credentials` 改为 `profile`
3. 顶栏右上角下拉菜单在「设置」上方新增「个人信息」直达项
4. 顶栏用户区域头像由固定占位图标改为展示真实头像（`avatar_url` 为空时回退占位图标）

### 2.3 数据流

```
用户选择图片 → 本地预览（objectURL）
    → 点击保存
      → ① 若有新头像：uploadImages([file]) 复用现有双模式上传链路，得到 URL
      → ② PUT /v1/users/me/profile  { displayName?, email?, avatarUrl? } 一次提交
      → ③ 成功 → authStore.fetchUserInfo() 刷新 → 顶栏 / 页面头像同步更新
```

移除头像：`PUT /v1/users/me/profile { avatarUrl: null }`，旧文件不删除，仅更新引用。

### 2.4 明确不做

| 事项 | 决策 |
|------|------|
| 管理后台（admin）改动 | **不做**，admin 用户管理不展示/不编辑头像 |
| 登录对话框展示头像 | **不做**，保持现状 |
| 前端图片裁剪（缩放/裁切/旋转） | **不做**，仅校验格式与大小 |
| 后端图片压缩 / 生成缩略图 | **不做**，原图直存直用 |
| 密码修改 | **不做**，不在本次范围 |
| 删除旧头像文件（本地 / OSS） | **不做**，仅更新引用 |
| 数据库变更 | **不做**，`avatar_url` / `display_name` / `email` 字段已存在 |
| LDAP / 飞书用户修改显示名称与邮箱 | **不做**，仅 LOCAL 用户可改，LDAP / 飞书只读 |
| 飞书 OAuth 头像自动同步 | **不做**，仅支持手动上传 |

## 3. 现状分析

### 3.1 已有能力（无需重复建设）

| 能力 | 位置 | 说明 |
|------|------|------|
| 用户字段 | `user` 表（V001） | `avatar_url`(512) / `display_name` / `email` / `username` 已存在 |
| 获取当前用户 | `GET /v1/users/me`（`UserController.getCurrentUser`） | 返回含 `avatarUrl` 的 `UserInfoVO` |
| 本地文件上传 | `POST /v1/files/upload`（`FileController.uploadFile`） | 存本地 `uploads/`，Nginx 映射 `/uploads/`，返回完整 URL |
| OSS 直传 | `POST /v1/oss/sts-token` + 前端 ali-oss 直传 | `desktop/src/utils/ossUpload.ts` |
| 上传模式选择 | `GET /v1/upload/config`（`UploadController`） | 返回 `storageMode: oss / local` |
| 前端上传封装 | `desktop/src/utils/imageUpload.ts` `uploadImages()` | 按 `getUploadConfig()` 自动分流本地 / OSS |
| 用户状态 | `desktop/src/stores/auth.ts` | `user` 含 `avatarUrl`；`fetchUserInfo()` 调 `/users/me` |

### 3.2 缺口

1. 后端缺「当前用户自助更新资料」接口（现有 `PUT /v1/users/{id}` 为管理员接口，需 `user:write`）
2. 桌面端缺个人信息页面与路由
3. 顶栏 `TopNav.vue` 头像为固定 `<el-avatar icon="User" />`（`TopNav.vue:66`），未使用 `avatarUrl`
4. 设置页 `SettingsView.vue` 侧边栏无「个人信息」项；`/settings` 默认重定向为 `git-credentials`

## 4. 技术选型

不引入任何新依赖，全部复用现有技术栈：

| 层 | 选型 | 说明 |
|----|------|------|
| 后端 | Spring MVC + MyBatis-Plus（现有） | 新增一个 Controller 端点 + Service 方法 |
| 前端 | Vue 3 + Element Plus（现有） | `el-avatar` / `el-upload` / `el-form` / `el-input` |
| 上传 | 现有 `uploadImages()` 双模式封装 | 本地模式走 `/files/upload`，OSS 模式走 STS 直传 |
| 状态 | Pinia `authStore`（现有） | 保存后 `fetchUserInfo()` 刷新，无需改 store 结构 |

## 5. 后端实现

### 5.1 新增接口 `PUT /v1/users/me/profile`

**位置**：`backend/src/main/java/cn/etarch/mao/user/controller/UserController.java`

**请求体**（均为可空，空值不更新；`avatarUrl` 传 null 表示移除头像）：

```json
{
  "displayName": "张三",
  "email": "zhangsan@example.com",
  "avatarUrl": "https://.../uploads/xxxx.png"
}
```

**响应**：更新后的 `UserInfoVO`（与 `GET /v1/users/me` 同构，含 `permissions` / `isAdmin`）。

**处理逻辑**：

1. 通过 `@AuthenticationPrincipal Long userId` 取当前用户
2. 加载 `User` 实体
3. 校验并落库（新增 `UserService.updateOwnProfile` 方法）：
   - `avatarUrl`：**所有登录方式**均可更新；空字符串 / null → 置 `null`（移除头像）
   - `displayName` / `email`：**仅 LOCAL 用户可更新**（判定：`passwordHash` 非空）。LDAP / 飞书用户若提交这两个字段，直接抛出业务异常（`PARAM_INVALID`，提示「LDAP/飞书账号的资料由系统维护，不可修改」），由前端同时禁用输入框做双保险
   - `displayName` 非空且 ≤ 128 字符（与表结构一致）
   - `email` 若提交则做基本格式校验（非空时）
4. `userMapper.updateById(user)`
5. 复用 `getCurrentUser` 中的 `UserInfoVO` 组装逻辑（抽成私有方法 `buildUserInfoVO(User user)` 供两处复用），返回更新后的完整用户信息

**路由说明**：`PUT /me/profile` 为两段路径，与现有单段 `PUT /{id}` 不冲突；`GET /me` 已有先例，Spring 能正确区分字面量与模板变量。

### 5.2 拦截器与安全

- 不新增 `@RequirePermission`：当前用户操作自己的资料属于自助行为，与现有 `GET /users/me` 一致，默认放行（由 JWT 认证保证登录态）
- `AuditInterceptor` 自动记录本次修改操作，无需额外编码

### 5.3 数据库

**无迁移脚本**。`avatar_url`、`display_name`、`email` 字段均已存在于 `user` 表。

## 6. 前端实现（desktop）

### 6.1 新增个人信息页 `desktop/src/views/settings/ProfileView.vue`

结构（`<script setup>` + Element Plus）：

- **头像区**：
  - `el-avatar :size="96" :src="previewUrl || authStore.user?.avatarUrl"`，无头像时回退占位（显示用户名首字符或 `User` 图标）
  - 「更换头像」：`el-upload`（`accept=".jpg,.jpeg,.png,.webp"`，`auto-upload=false`，`:show-file-list=false`），`before-upload` 校验 MIME/扩展名与 ≤5MB；选择后 `URL.createObjectURL` 生成本地预览，未保存前不发起任何上传
  - 「移除头像」：`authStore.user?.avatarUrl` 非空时显示
- **资料区**（`el-form` + `el-input`）：
  - 用户名：只读文本
  - 显示名称：`el-input`，`:disabled="!isLocalUser"`（`isLocalUser = authStore.user 登录方式为 LOCAL`）
  - 邮箱：`el-input`，同上
  - 登录方式：只读标签（LOCAL / LDAP / 飞书）
- **保存按钮**：提交时按 2.3 数据流执行；成功后 `ElMessage.success` 并 `authStore.fetchUserInfo()`

**本地预览注意**：objectURL 仅在保存流程使用，保存成功后销毁（`URL.revokeObjectURL`），页面头像改从 `authStore.user.avatarUrl` 读取，保证与顶栏一致。

### 6.2 路由与侧边栏

- `desktop/src/router/index.ts`：
  - `/settings` 的 `redirect` 从 `'/settings/git-credentials'` 改为 `'/settings/profile'`
  - 在 `children` 中新增 `{ path: 'profile', name: 'Profile', component: () => import('../views/settings/ProfileView.vue') }`
- `desktop/src/views/settings/SettingsView.vue`：侧边栏 `<nav>` 顶部新增「个人信息」`router-link`（`to="/settings/profile"`）

### 6.3 顶栏 `desktop/src/components/common/TopNav.vue`

1. 用户区头像改为：

```html
<el-avatar :size="24" :src="authStore.user?.avatarUrl || undefined">
  <el-icon v-if="!authStore.user?.avatarUrl"><User /></el-icon>
</el-avatar>
```

（`src` 为空时回退占位图标；`authStore.user` 更新后自动响应式刷新，无需额外逻辑）

2. 下拉菜单在「设置」项上方新增：

```html
<el-dropdown-item command="profile"><el-icon><User /></el-icon>个人信息</el-dropdown-item>
```

3. `handleCommand` 中处理 `profile`：`router.push('/settings/profile')`

### 6.4 authStore

无需改动。`User` 接口已含 `avatarUrl`，保存成功后调现有 `fetchUserInfo()` 刷新即可。

## 7. 测试与验证

| 项 | 内容 |
|----|------|
| 后端编译 | `cd backend && mvn compile` |
| 后端单测（可选，建议） | 为 `UserService.updateOwnProfile` 补充校验用例：LOCAL 可改资料、LDAP 改资料被拒、avatarUrl 置空移除 |
| 前端类型检查 | `cd desktop && npx vue-tsc --noEmit` |
| 前端构建 | `cd desktop && npm run build` |
| 手动验证 | ① LOCAL 用户改显示名/邮箱 + 上传头像 → 顶栏头像即时更新 ② LDAP 用户资料框禁用 ③ 移除头像 → 恢复占位 ④ 5MB 以上 / 非图片文件被拦截 ⑤ 本地与 OSS 两种 storageMode 各验证一次 |

## 8. 落地清单

### 后端（1 项）
- [ ] `UserController` 新增 `PUT /v1/users/me/profile`；`UserService` 新增 `updateOwnProfile`；抽取 `buildUserInfoVO` 复用

### 前端（4 项）
- [ ] 新增 `desktop/src/views/settings/ProfileView.vue`（头像区 + 资料区 + 保存流程）
- [ ] `router/index.ts` 注册 `profile` 路由，`/settings` 默认重定向改为 `profile`
- [ ] `SettingsView.vue` 侧边栏新增「个人信息」置顶项
- [ ] `TopNav.vue` 展示真实头像 + 下拉新增「个人信息」入口

### 发版（1 项）
- [ ] 根 `CHANGELOG.md` 当前版本下追加条目：
  - `### 后端`：新增 `PUT /v1/users/me/profile` 支持用户自助修改显示名称/邮箱/头像
  - `### 前端（桌面 / Web / 安卓）`：设置页新增「个人信息」页（上传/移除头像、修改资料），顶栏显示真实头像

### 验证（1 项）
- [ ] 后端 `mvn compile`（含可选单测）+ 前端 `vue-tsc` / `npm run build` 通过

> 说明：本方案不涉及数据库迁移、不涉及 admin、不涉及安卓原生壳（`android/` 目录零改动），按 CLAUDE.md 约定改动 `backend/` 与 `desktop/` 后更新 CHANGELOG。

## 9. 风险与边界

| 风险点 | 影响 | 应对 |
|--------|------|------|
| `PUT /me/profile` 与管理员 `PUT /{id}` 路由混淆 | 低 | `/me/profile` 为两段路径，Spring 精确匹配优先，无冲突；开发时补充该场景手工验证 |
| LDAP / 飞书用户误改资料 | 中 | 前端禁用输入框 + 后端强校验双重保障 |
| OSS URL 长度超过 `avatar_url` VARCHAR(512) | 低 | 当前 OSS 域名+路径预计 < 200 字符，超出时由 DBA 调整列宽（暂不需处理） |
| 本地模式头像 URL 依赖后端 `baseUrl` 配置 | 低 | 现有 `FileController.toVO` 已保证返回完整 URL，顶栏直接渲染 |
