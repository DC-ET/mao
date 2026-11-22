### 后端

- **浏览器直播回放（录制 + 回看）**：新增会话级回放读取 API（场次列表 / 单场时间轴 / 单帧图片），数据源为会话 runtime 目录 `.mao-browser/replay/`（sidecar 采集侧录制，无 DB 表），带会话归属校验与 liveId/seq 白名单防穿越；崩溃 / 2h 超时未正常结束的场以「未正常结束」标注、按最后一帧兜底展示。
- **清理时效后台化（V202）**：浏览器直播回放保留天数（`harness.cleanup.browserReplayTtlDays`，默认 7，0=关闭按天清理）与存量 shell 输出 / 网页全文保留天数（`harness.cleanup.shellOutputMaxAgeDays`，默认 7，0=不清理）提为后台设置，清理调度器每轮现读、保存后下一轮清理即生效无需重启；回放 TTL 清理跳过活跃会话与纯数字目录外的路径；存量 env（`MAO_CLEANUP_SHELL_MAX_AGE_DAYS` / 新增 `MAO_CLEANUP_BROWSER_REPLAY_DAYS`）由启动引导一次性导入 DB。
- **录制开关下发**：`browserLive.recordEnabled`（默认关）开启后，CLOUD 经容器 envelope envVars 注入 `MAO_BROWSER_LIVE_RECORD=1`；readiness 接口（仅登录即可读）随响应下发开关值，供桌面主进程注入 LOCAL shell env。V202 种子行随 TS 启动自动执行。

### 前端（桌面 / Web / 安卓）

- **回放播放器**：浏览器直播 Tab 非直播态新增「历史回放」入口 → 场次列表（时间 / 时长 / 帧数 / 截断与未结束标记）→ 帧级播放器：自绘时间轴密度带（活跃段浓、静止段稀，点击定位）、播放 / 暂停、1x/2x/4x 倍速、逐帧步进、跳到开头 / 结尾；回放中若重新开播仅在顶部提示并可一键切回实时，不自动打断复盘；回放期间锁定所属会话，切会话不漂移。
- **回放入口可达性**：输入框上方「浏览器」状态条在无直播但当前会话已有历史回放时也显示（30s 惰性探测），点击直接落在回放列表——刷新 / 关 Tab 后回放仍可达；LOCAL 会话在非执行端（Web）不显示回放。

### 桌面 Electron

- **LOCAL 回放读取**：主进程枢纽新增回放 IPC（场次列表 / 时间轴 / 单帧），fs 直读本机 `~/.mao/runtime/<hostKey>/<sid>/.mao-browser/replay/`，liveId/seq 白名单 + 目录 containment 断言防穿越。
- **录制开关注入**：主进程经 readiness（带 5 分钟缓存、登录态变化即失效）取录制开关，向 LOCAL shell env 注入 `MAO_BROWSER_LIVE_RECORD`；新增单场体积上限 env `MAO_BROWSER_LIVE_RECORD_MAX_MB`（默认 300MB，超限截断停录本场、直播不受影响）。

### 管理后台

- **系统设置 → 浏览器直播（新分组）**：启用操作录制（switch，默认关）+ 回放保留天数 + Shell 输出保留天数（number，0–365，保存后即时生效）。
