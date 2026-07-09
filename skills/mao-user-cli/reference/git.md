# Git 凭证模块（git）

## 模块职责

管理当前用户的 Git 访问凭证（域名 + access token），供 CLOUD 模式按 git URL 克隆等场景使用。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列表 | `git list` |
| 新建 | `git create` |
| 更新 | `git update` |
| 删除 | `git delete` |

---

## 命令：mao-user git list

### 用途

列出已保存的 Git 凭证。返回中的 `accessToken` 会被服务端脱敏为 `****`。

### 参数说明

无。

### 示例

```bash
mao-user git list --json
```

---

## 命令：mao-user git create

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
mao-user git create --domain git.example.com --access-token 'ghp_xxx' --description '工作账号'
```

---

## 命令：mao-user git update

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
mao-user git update --id 2 --access-token 'new_token'
```

---

## 命令：mao-user git delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 凭证 ID |

### 示例

```bash
mao-user git delete --id 2
```

## 注意事项

- access token 属于敏感信息，避免写入 shell 历史时可改用环境变量拼命令
- CLOUD `workspace-mode=git` 前应确保对应域名凭证已配置
