# 三级 Shell 环境变量（env）

管理注入到 CLOUD Agent Shell、云端终端、容器内 shell 的环境变量。三层优先级：**工作区 > 用户 > 系统全局**。LOCAL 使用本机环境，不读这三层。

桌面「设置 → 环境变量」维护用户层；右侧「任务」面板工作区区块维护工作区层（仅 CLOUD 且已有会话）。管理后台「系统设置 → 工具与终端 → Shell 环境变量」维护系统层与注入总开关。用户详情「环境变量」Tab 只读查看该用户的用户层与工作区层。

## 口径

| 项 | 说明 |
|----|------|
| 生效 | 写入后本实例缓存立即失效，最长约 5 秒对新执行的命令生效。已打开的终端不刷新，需重开 |
| 总开关 | 系统设置 `shell.envVars.enabled`。缺省或非 `false`/`0` 视为开启。关闭后三层都不注入，平台内置凭据仍在 |
| 存储 | 值 AES 加密。用户侧接口不返回值；管理员只读接口只给密文长度掩码 `**** (N chars)` |
| 更新 | 不传 `--value`，或传入空串，都保留原密文。`--note` 传空串清空备注 |
| 限额 | 每层最多 50 条；值最长 2048 字节（UTF-8）；备注最长 256 字符 |
| 变量名 | 字母或下划线开头，仅含字母、数字、下划线，最长 128 |
| 保留键 | `PATH` / `HOME` / `LD_PRELOAD` / `NODE_OPTIONS` / `BASH_ENV` / `PYTHONPATH` 等，以及 `GIT_TOKEN_` / `MYSQL_` / `APP_` / `MAO_` 前缀。任何一层都不能覆盖平台注入的 `GIT_TOKEN_*`、`MAO_TOKEN`、`ECP_TOKEN`、`HOME`、`PATH` |
| 工作区路径 | 传服务端上的绝对路径，与任务面板显示的一致。服务端用 `path.resolve` 归一；相对路径按后端进程工作目录解析，不要用。空路径会落到全局工作区根，因此 `workspace list` / `workspace create` 必须显式传 `--workspace` |

注入总开关：

```bash
mao settings set --key shell.envVars.enabled --value false
mao settings set --key shell.envVars.enabled --value true
```

## 命令选择

| 场景 | 命令 | 权限 |
|------|------|------|
| 本人用户级变量 | `env user list\|create\|update\|delete` | 登录 |
| 当前工作区变量 | `env workspace list\|create\|update\|delete` | 登录 |
| 某会话实际生效的键（不含值） | `env effective` | 登录，且会话属于自己 |
| 系统全局变量 | `env system list\|create\|update\|delete` | `settings:read` / `settings:write` |
| 查看某用户的用户级变量 | `env user-of` | `user:read` |
| 查看某用户的工作区变量 | `env workspace-of` | `user:read` |

管理员不能代用户写入用户层或工作区层变量。

## 命令：env user

`GET|POST|PUT|DELETE /user/env-variables`

| 参数 | 必填 | 含义 | 后端字段 |
|------|------|------|----------|
| `--key` | create 必填，update 可选 | 变量名 | `envKey` |
| `--value` | create 必填（与 `--value-file` 二选一） | 变量值。update 省略则保留原值 | `envValue` |
| `--value-file` | 否 | 从文件读入变量值，避免写进 shell 历史 | `envValue` |
| `--note` | 否 | 备注 | `note` |
| `--id` | update / delete 必填 | 变量 ID | 路径 |

```bash
mao env user list --json
mao env user create --key OPENAI_API_KEY --value-file ./key.txt --note '个人 key'
mao env user update --id 3 --note '只改备注'
mao env user delete --id 3
```

## 命令：env workspace

`GET|POST /user/workspace-env-variables`，`PUT|DELETE /user/workspace-env-variables/{id}`

list / create 必填 `--workspace`（服务端绝对路径）。update / delete 只按 `--id` 定位，不能改绑到另一个工作区。

```bash
mao env workspace list --workspace /opt/mao-data/workspace/demo --json
mao env workspace create --workspace /opt/mao-data/workspace/demo \
  --key API_BASE --value https://api.example.com
mao env workspace update --id 8 --value 'https://api.example.com/v2'
mao env workspace delete --id 8
```

## 命令：env effective

`GET /sessions/{id}/effective-env`

返回当前会话配置态视图：键名、来源（`WORKSPACE` / `USER` / `SYSTEM` / `BUILTIN` / `INHERITED`）、备注，以及各来源条数和总开关 `enabled`。不返回值。来源按实际生效的最高优先级标注。

| 参数 | 必填 | 含义 |
|------|------|------|
| `--session-id` | 是 | 会话 ID，必须属于当前用户 |

```bash
mao env effective --session-id 42 --json
```

## 命令：env system

`GET|POST|PUT|DELETE /admin/system-env-variables`

参数与 `env user` 相同。list 需 `settings:read`，写操作需 `settings:write`。系统层优先级最低，用户层和工作区层可覆盖同名键。

```bash
mao env system list --json
mao env system create --key CORP_API_BASE --value https://corp.example.com --note '全站默认'
mao env system update --id 1 --note '改备注，值留空即保留'
mao env system delete --id 1
```

## 命令：env user-of / env workspace-of

| 命令 | 接口 | 参数 |
|------|------|------|
| `user-of` | `GET /admin/users/{id}/env-variables` | `--user-id` |
| `workspace-of` | `GET /admin/users/{id}/workspace-env-variables` | `--user-id`；可选 `--workspace`，省略则列出该用户全部工作区 |

```bash
mao env user-of --user-id 7 --json
mao env workspace-of --user-id 7 --json
mao env workspace-of --user-id 7 --workspace /opt/mao-data/workspace/demo --json
```
