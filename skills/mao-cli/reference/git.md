# Git 凭证模块（git）

## 模块职责

管理当前用户的 Git 访问凭证（域名 + access token），供 CLOUD 模式按 git URL 克隆等场景使用。

> **注入范围（2026-11-06 起）**：凭据仍按用户存储，但注入给会话时只取「用户凭据域 ∩ 当前 Agent 允许域」
> （Agent 编辑页的「Git 凭据域」白名单）。未配置允许域的 Agent 按系统设置「Git 凭据域策略」处理：
> 宽松=不限制（默认，兼容存量）、严格=不注入。因此同一账号在不同 Agent 下能访问的 Git 服务可能不同。
>
> **系统默认兜底（2026-11-12 起）**：管理员可在管理后台按域名配置系统默认 Token；白名单放行且用户未配置
> 该域时自动注入系统默认（同域用户 Token 优先）。默认 Token 通常为只读，需要写权限仍需自行配置该域凭证。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列表 | `git list` |
| 新建 | `git create` |
| 更新 | `git update` |
| 删除 | `git delete` |

管理端另有按用户查看/删除凭证的接口：`GET /v1/admin/users/:id/git-credentials`（`user:read`）、
`DELETE /v1/admin/users/:id/git-credentials/:credentialId`（`user:write`），Token 同样脱敏，供用户详情视图使用。

---

## 命令：mao git list

### 用途

列出已保存的 Git 凭证。返回中的 `accessToken` 会被服务端脱敏为 `****`。

### 参数说明

无。

### 示例

```bash
mao git list --json
```

---

## 命令：mao git create

### 用途

新增一条域名凭证。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--domain` | 是 | 字符串 | Git 主机域名，如 `github.com` → `domain` |
| `--access-token` | 是 | 字符串 | 访问令牌 → `accessToken` |
| `--description` | 否 | 字符串 | 备注 → `description` |

### 示例

```bash
mao git create --domain git.example.com --access-token 'ghp_xxx' --description '工作账号'
```

---

## 命令：mao git update

### 用途

更新已有凭证。至少提供一个字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 凭证 ID |
| `--access-token` | 否 | 字符串 | 新 token |
| `--description` | 否 | 字符串 | 新备注 |

注意：域名创建后不可通过本命令修改。

### 示例

```bash
mao git update --id 2 --access-token 'new_token'
```

---

## 命令：mao git delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 凭证 ID |

### 示例

```bash
mao git delete --id 2
```

## 注意事项

- access token 属于敏感信息，避免写入 shell 历史时可改用环境变量拼命令
- 克隆地址（`workspace-mode=git` 的 `gitCloneUrl`）**不要携带账号或 Token**，服务端会直接拒绝；鉴权统一由该域名的凭证经 `GIT_ASKPASS` 与 `GIT_TOKEN_<域名>` 环境变量完成
- 凭证会被写进工作区 `.git/config`、会话日志与对话历史，因此任何位置都不要把 Token 拼进仓库 URL
- CLOUD `workspace-mode=git` 前应确保对应域名凭证已配置，否则私有仓库克隆会失败
