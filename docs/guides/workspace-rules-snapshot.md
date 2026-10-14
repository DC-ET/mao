# 工作区规则会话级快照（排障与运维）

> 面向：运维 / 客服 / 排障。技术方案见 `docs/plan/2026-10-14-workspace-rules-snapshot-technical-design.md`。
> 关键词：workspace-rules、前缀缓存塌陷、8~9k 命中指纹、快照、排障日志。

## 1. 一句话说明

每个会话第一次读到工作区的 `AGENTS.md` 时，后端会把「工作区规则」这一节的文本**冻结**下来（落库到 `session_workspace_rules`）。同一会话后续每一轮都用这份冻结文本，**会话内改动 `AGENTS.md` 不会立刻在本会话生效**。

这么做是因为该节是系统提示的最后一节：它只要变一个字节，其后的系统提示、工具定义和全部历史消息都要重算，前缀缓存整体塌陷。生产实测一次塌陷多花约 0.87 元、首字延迟增加 5~6 秒，而同一工作区往往有 100+ 个会话共用一份 `AGENTS.md`，任一会话编辑都会连带影响其他会话。

## 2. 用户可见的行为变化（客服话术）

| 场景 | 现在的行为 |
|---|---|
| 会话内（人或 Agent）编辑 `AGENTS.md` | 本会话继续用旧规则；**新开会话**才用新规则 |
| 会话内编辑后触发一次**压缩**（上下文写满自动压缩 / 手动压缩） | 压缩提交成功后立即解冻，下一轮就用新规则 |
| 删除会话 | 快照随之删除；再建同名会话自然重新读取 |
| 后端重启 / 蓝绿发布 | 快照在 MySQL 里，重启后沿用同一文本，不会塌陷 |
| 跨天 | 不主动刷新（这是有意的：跨天仍能命中前缀缓存） |

如果用户反馈"我改了 AGENTS.md 但 Agent 没按新规则做"：让他**新开一个会话**，或把当前会话上下文聊到触发一次压缩即可。也可以直接让 Agent 用 `read_file` 读一次 `AGENTS.md`——文件本身永远是最新的，冻结的只是系统提示里那一节。

## 3. 排障日志

日志模块为 `harness`，均是一条 info：

| 日志内容（前缀） | 含义 |
|---|---|
| `workspace rules snapshot pinned session=… chars=… source=… mtime=…` | 该会话首次冻结（或失效后重新冻结）。`source=local-reported` 表示 LOCAL 模式、内容由桌面端上报 |
| `workspace rules changed on disk but snapshot retained session=… disk_hash=… pinned_hash=…` | 磁盘上的 `AGENTS.md` 变了，但本会话仍用冻结文本。**同一份磁盘内容每会话只打一次**，不会每轮刷屏 |
| `workspace rules empty on disk but snapshot retained session=…` | 这一轮没读到规则内容（LOCAL 桌面端漏报，或文件被删/清空），仍继续用冻结文本——摘掉该节本身就会引发一次塌陷 |
| `workspace rules snapshot invalidated session=… reason=compaction-committed` | 压缩提交成功，已解冻，下一轮重新读取 |

与既有 `prefix changed … changedSections=[workspace-rules]` 告警的分工：那条来自 `prompt-prefix-monitor`，说明**实际发出的前缀真的变了**；上线后它只应出现在「新会话首次」与「压缩提交后」。如果它频繁出现且不是这两种时机，说明快照没生效（例如数据库异常导致每轮降级读盘），去看有没有 `Failed to resolve workspace rules snapshot` 的 warn。

## 4. 数据库与运维操作

表：`session_workspace_rules`（一行一会话，主键 `session_id`）。

```sql
-- 看某会话冻结了什么
SELECT session_id, workspace, CHAR_LENGTH(rules_text) AS chars, rules_hash, source_path, source_mtime, updated_at
  FROM session_workspace_rules WHERE session_id = 811;

-- 强制让某会话下一轮重新读取 AGENTS.md（无需重启后端）
DELETE FROM session_workspace_rules WHERE session_id = 811;
```

行数≈有活跃规则的会话数，随会话删除自动回收（会话删除、边路任务升级为主会话两条路径都会物理删行）。不设 TTL；若发现异常累积，可按 `updated_at` 评估后清理。

## 5. 失效与降级

- **数据库不可用**：该轮退化为直接读盘（行为回到改造前），打 warn `Failed to resolve workspace rules snapshot`，不阻断对话。
- **解冻失败**：压缩照常成功，只打 warn `Failed to invalidate workspace rules snapshot`。
- **代码回滚**：回滚代码 + 重新部署即回到"每轮读盘"的旧行为；表残留无副作用（不会被读取），需要时 `DROP TABLE session_workspace_rules;`。
