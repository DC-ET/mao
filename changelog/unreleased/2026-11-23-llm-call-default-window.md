### 后端

- 管理端调用流水 `GET /v1/admin/llm-calls` 默认只查最近 7 天（含今天，北京时间日历日）。新增 `range=1D|3D|7D|30D|90D|ALL`，`ALL` 才不限时间；`dateFrom`/`dateTo` 与原有深链参数 `startDate`/`endDate` 仍是显式区间，优先于预设档。非法档位或日期直接拒绝，避免再对 `llm_call` 做全表计数。列表改为按 `created_at DESC, id DESC` 取页，时间窗能沿创建时间索引扫完一页就停。用户端 `GET /v1/llm-calls/me` 不变，不带日期时仍不限时间。

### 管理后台

- 调用流水的开始/结束日期改为与会话列表相同的时间档：默认「最近 7 天」，可选 1 / 3 / 30 / 90 天、自定义或全部时间。用量分析、用户用量带 `startDate`/`endDate` 跳过来时仍按那个区间筛选。

### 终端 CLI（mao-cli）

- `mao llm-call list` 增加 `--range`（`1d`/`3d`/`7d`/`30d`/`90d`/`all`）。不传时间参数时后端按最近 7 天返回；`--range all` 查看全部时间。`--start-date` / `--end-date` 仍表示显式区间。
