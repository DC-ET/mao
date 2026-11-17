# runtime — 运行监控

管理后台已移除「运行监控」页面；会话列表仍由本 CLI 与 `GET /admin/runtime/sessions` 提供。主机资源在管理后台「主机状态」，CLI 用 `runtime host`。

## 用途

查看运行态会话，或读取后端所在机器的当前 CPU、内存、硬盘与运行时容器数。

## 命令选择

| 场景 | 命令 |
|------|------|
| 运行态会话列表 | `runtime sessions` |
| 后端所在机器的当前资源 | `runtime host` |

与 `session list` 的区别：未传 `--phase` 时，服务端默认聚焦  
`RUNNING,RESUMING,WAITING_APPROVAL,CANCELLING,FAILED,CANCELLED`（活跃相位来自 `ACTIVE_PHASES`）。

## 命令：runtime sessions

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 用户 ID | `userId` |
| `--agent-id` | 否 | 整数 | — | Agent ID | `agentId` |
| `--execution-mode` | 否 | 字符串 | — | `CLOUD`/`LOCAL` 等 | `executionMode` |
| `--phase` | 否 | 字符串 | 见上默认 | 阶段过滤（可逗号多值，由服务端解析） | `phase` |
| `--keyword` | 否 | 字符串 | — | 关键词 | `keyword` |
| `--status` | 否 | 字符串 | — | 状态 | `status` |

`GET /admin/runtime/sessions`（需 `session:read`）

```bash
mao runtime sessions --page 1 --size 20
mao runtime sessions --phase RUNNING --execution-mode LOCAL
```

## 命令：runtime host

无参数。`GET /statistics/host`（需 `analytics:read`）。

返回后端进程所在这一台机器的当前快照，不含远程数据库，也没有历史曲线：

| 字段 | 含义 |
|------|------|
| `cpu.usagePercent` | 相邻两次采样间的 CPU 利用率。页面约 15 秒轮询一次，CLI 连续调用时间隔即采样窗口 |
| `cpu.load1` / `load5` / `load15` | 1 / 5 / 15 分钟负载 |
| `memory` | `memorySource=proc` 时可用量是 Linux MemAvailable（含可回收缓存）。`os` 不计可回收缓存，占用率会偏高 |
| `disks` | 系统盘，以及工作区 / 上传 / 运行时 / 用户目录 / `/var/lib/docker` 里挂载点不同的盘。同一挂载点只留一条。`usagePercent` 是 `df` 的 Capacity，不是已用除以总块数 |
| `containers` | mao 运行时容器。`available=false` 时 `reason` 说明 Docker 不可用，此时各计数为 0，不表示没有容器。`untracked` 是残留容器，`busy` 是有任务的容器，二者都含在 `total` 里 |

```bash
mao runtime host
mao runtime host --raw
```

## 成功失败判断

- `code===0` 成功
- `runtime sessions` 的列表结构与管理端会话列表一致（`records`/`total`/`page`/`size`）
- `runtime host` 的 `data` 即主机快照。`containers.available===false` 仍是成功，表示这台机器没连上 Docker
