# browser-use 技能 Windows LOCAL 支持（技术设计）

日期：2026-11-21
状态：方案待评审
前置：`2026-11-20-browser-live-pip-technical-design.md`（v2，已落地）、`2026-11-21 Web 端观看入口`（已落地）

## 0. 背景与结论

browser-use 直播链路已覆盖：桌面 Electron（PiP + Tab）、Web（TopNav 入口）、Windows 用户走 CLOUD（shell 在 Linux 服务端执行，本机只观看）。唯一空白是 **Windows 桌面客户端 LOCAL 模式**：技能跑不起来，观看链路本身是通的。

卡点不在 Playwright（`@playwright/cli` 官方支持 Windows），而在**技能封装层**：

- 技能唯一入口是 bash 脚本 `browser_cli.sh`，而 Windows LOCAL 的 shell 宿主是 `powershell.exe`（`desktop/electron/localShell.cjs:38-46`，注释明确不用 Git Bash），系统无 bash；
- 依赖按需安装链（`backend-ts/src/browser-deps/browser-deps.service.ts`）detect 与降级判定是 Linux/macOS 口径，Windows 上会「下载 chromium 成功但检测不到」而报 failed；
- 依赖 `.cmd` shim 的 spawn（npm / playwright-cli / npx）在 Windows + Node ≥18 下不能直接 execFile（EINVAL / ENOENT）。

**方案一句话**：把 wrapper 的直播编排逻辑移植为**零依赖 node 单文件入口 `browser_cli.mjs`**（node 本来就是硬前置），SKILL.md 按 `node -e "console.log(process.platform)"` 分流；deps 服务补 win32 检测与安装分支（复用既有注入 seam）；sidecar 与 PiP 零改动或近乎零改动。

## 1. 现状分层拆解

| 层 | 组件 | Windows LOCAL 现状 | 依据 |
|---|---|---|---|
| 观看 UI | PiP 窗口 / Tab / TopNav | ✅ 可用（Electron API 跨平台，无平台守卫） | `desktop/electron/pipWindow.cjs` |
| 观看数据 | sidecar SSE → Electron 枢纽 | ✅ 可用（127.0.0.1 SSE、live.json 发现均跨平台） | `browserLive.cjs:126`、`localRuntimePaths.cjs:11` |
| 采集 | sidecar（零依赖 node） | ✅ 可用（CDP WS、`process.kill(pid,0)` 存活探测、纯观察者不杀浏览器） | `browser-live-host.mjs:236-259` |
| shell 宿主 | localShell PowerShell 协议 | ✅ 可用（stdin 喂命令、UTF-8 init、taskkill 树杀） | `localShell.cjs:42-53,342-353` |
| 技能装载 | zip 解包真目录（非 symlink） | ✅ 可用（无 Windows symlink 权限问题） | `localSkills.cjs:85-87,124-126`、WS `syncSkillsToClient` 下发 `/v1/skills/sync-package` |
| **技能入口** | `browser_cli.sh`（bash） | ❌ **PowerShell 宿主无 bash，无法执行** | `localShell.cjs:38-46` |
| **依赖检测** | `browser-deps.service` detect | ❌ chromium 缓存根固定 `~/.cache/ms-playwright`，Windows 实际在 `%LOCALAPPDATA%\ms-playwright`；chrome 候选无 win32 路径 | `browser-deps.service.ts:152-172` |
| **依赖安装** | host 安装链 | ⚠️ `npm i -g` 可用；`uname`/`apt-get` 在 Windows 失败后走 chromium 下载（这步其实能成），但下载后检测不到 → 误报 failed | `browser-deps.service.ts:280-331` |
| **shim spawn** | exec('npm'/'playwright-cli') | ❌ Windows 上均为 `.cmd` shim，execFile 直调不可靠 | Node ≥18 对无 shell 的 .cmd/.bat 拒绝 |

LOCAL 运行时布局（跨平台一致，`~` 即 `%USERPROFILE%`）：

```
~/.mao/runtime/<hostKey>/<sessionId>/          ← 会话运行时根（wrapper 上跳两级得到）
├── skills/browser-use/scripts/browser_cli.{sh,mjs}   ← zip 解包的真实目录
├── .mao-browser/{live.json, host.pid, host.ready, cdp/, config/, logs/}
```

`SKILL_DIR/../..` 的运行时根推导在 Windows 下同样成立（zip 真目录 + `path.resolve`）。

## 2. 目标 / 非目标

目标：

1. Windows 桌面客户端 LOCAL 模式：Agent 经 browser-use 技能完成浏览器自动化（open/snapshot/click/type/close 全流程），体验与 macOS/CLOUD 一致。
2. 观看链路在 Windows LOCAL 打通：PiP 出窗、双击放大 Tab、停止按钮、退出清理。
3. 依赖按需安装链在 Windows 后端（LOCAL 后端跑在用户机上）可用：管理员启用技能 → 自动装 CLI + chromium（免管理员权限）。
4. 不回归 POSIX：macOS/Linux/CLOUD 行为零变化（M1 期间 bash wrapper 仅在文件头加一行注释，其余原样保留）。

非目标：

- 不支持 Windows 上的 docker 运行时分支（LOCAL 恒为 host 模式；docker 分支本就只服务 Linux 服务器）。
- 后端与桌面**不同机**的拓扑（Windows 桌面连远程 Linux 后端，SaaS 形态）：deps 安装链在后端宿主执行，D2 不会在用户机生效，用户机浏览器内核前置 = 系统 Chrome（`channel: chrome`）或手动 `npx playwright-cli install-browser`，无自动安装路径（见 D2「适用拓扑」）。
- 不覆盖 mao-agent（终端 CLI）作为 Windows 本地执行端的场景——其 shell 宿主是另一条链路；node 入口天然兼容（只要其宿主能跑 `node`），真要支持时另行确认。
- 不做 Windows 安装包签名 / SmartScreen 白名单治理（属于桌面发版体系）。
- 不统一改 CLOUD 端依赖预装口径（服务端仍按 DEPLOY.md 预装推荐）。

## 3. 技术选型与决策点

### D1 wrapper 入口形态：node 单文件 `browser_cli.mjs`（推荐），而非 PowerShell 移植

备选对比：

| | A. node 单文件（推荐） | B. browser_cli.ps1 移植 |
|---|---|---|
| 实现份数 | 1（三端共用） | 2（bash + ps1 永久双维护，channel 降级/端口探测/提示文案每次双改） |
| 语言能力 | JSON 组装、argv 解析、detached spawn 全是现成 API（bash 版本来就在 orchestrate node -e 片段） | PS 5.1 语法啰嗦（ConvertFrom-Json、Start-Process -WindowStyle Hidden），detached spawn 仍要借 node |
| 调用语法 | `node "<技能目录>/scripts/browser_cli.mjs" open …` 在 bash 与 PowerShell **逐字符相同**（双引号路径两壳语义一致） | 两套调用示例 |
| 前置依赖 | node ≥22 本来就是硬前置（npx + sidecar 全局 WebSocket） | 同 |

**决策：A。** 分期控风险：M1 只把 Windows 流量切到 node 入口（POSIX 仍走 bash，零回归面）；真机 smoke 通过后 M2 把 POSIX 也切到 node 入口并删除 bash wrapper（消除双维护）。

`browser_cli.mjs` 职责 = 现 bash wrapper 的四件事（头注释 `browser_cli.sh:1-23`）：

1. CLI 解析：优先 PATH 上的 `playwright-cli`，否则 npx 拉取（`PWCLI_PACKAGE` 可固定版本）；
2. live 环境准备（尽力而为，任一环节失败即纯透传 CLI）：运行时根推导 → node ≥22 检查（`typeof WebSocket`）→ `.mao-browser` 目录创建；
3. sidecar 确保存活：`spawn(process.execPath, [host, …], { detached: true, stdio: 'ignore', windowsHide: true })` + 写 `host.pid` + 轮询 `host.ready`（`windowsHide` 防 Windows 控制台闪窗，POSIX 无影响）；`host_alive` 用 `process.kill(pid, 0)`；
4. `open` 注入：按 CLI 会话名挑 CDP 端口（文件 + `fetch /json/version` 探活）→ 组装 config（`--remote-debugging-port`；`linux && getuid()===0` 才注 `--no-sandbox`——Windows/macOS 不注）→ chrome/chromium 探测降级 → 末尾 `spawnSync(cli, args, { stdio: 'inherit' })` 转发退出码。

**Windows 专属实现注意（写进代码注释与测试点）**：

- **shim spawn**：Windows 上 `playwright-cli`/`npx` 是 `.cmd` shim，Node ≥18 无 shell 直 spawn 报 EINVAL。策略：全局 CLI 存在时经 `npm prefix -g`（execSync 默认走 shell，win32 可用；输出需 trim）定位 `<prefix>/node_modules/@playwright/cli`，bin 路径读该包 package.json 的 `bin` 字段解析（string / object 两种形态）后直接用 node 跑（绕开 shim，也绕开 shell:true 的引号坑）；win32 判定「CLI 已装」同样以 npm prefix 下包存在为准（`.cmd` shim 本身无法 execFile 直探，扫 PATH 属降级分支）。CLI 未装时兜底**先试直 spawn `npx-cli.js`**：官方 node 布局下 `<nodeDir>/node_modules/npm/bin/npx-cli.js` 可从 `process.execPath` 推导，`spawn(process.execPath, [npxCliJs, …args])` 无 shell、参数零转义（npx.cmd 内部本就是这条命令）；该文件不存在（非官方布局）才末位退 `spawnSync('npx', args, { shell: true })`——注意 cmd.exe 元字符使「无空格即安全」不成立：URL 常含 `&`（命令分隔符）与 `%`（`%xx%` 环境变量展开），都会破参，必须所有参数统一加引号并在排障文档记录 `%` 无法转义的残留风险。
- **argv 解析**：照抄 bash 版语义（`-s=NAME` / `-s NAME` / `PLAYWRIGHT_CLI_SESSION` / `--config` 检测），node 里直接遍历 `process.argv.slice(2)`。
- **chromium 探测**：win32 缓存根 `%LOCALAPPDATA%\ms-playwright`（尊重 `PLAYWRIGHT_BROWSERS_PATH`），glob `chromium-*/chrome-win*/chrome.exe`；darwin `~/.cache/ms-playwright` 不变（现 bash 行为）；Linux 不变。
- 纯 POSIX 残留（`id -u`、`tr -c`、glob）全部换 node 等价实现。

### D2 依赖安装链 Windows 分支（browser-deps.service）

- **适用拓扑前提**：安装链跑在后端宿主，本节只在「后端与桌面同机」（Windows 自托管单机 / 开发态，即目标 3 口径）时被执行。Windows 桌面连远程 Linux 后端（SaaS 形态）时本节不生效——用户机内核前置为系统 Chrome，无自动安装路径（已列入非目标）。
- **detectChrome（`browser-deps.service.ts:152-172`）**：候选路径加 win32 分支——`%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`（`--version` 探测同现逻辑；真机确认点：Windows 上 `chrome.exe --version` 历史上可能无 stdout 静默退出，`present` 判定不受影响——退出码 0，`version` 可能为空，可接受或改读文件版本信息）。chromium 缓存根平台化：win32 → `PLAYWRIGHT_BROWSERS_PATH ?? %LOCALAPPDATA%\ms-playwright`（`%LOCALAPPDATA%` 缺省时回退 `homedir()/AppData/Local`，服务上下文可能无该环境变量），二进制 glob `chrome-win*/chrome.exe`。既有测试注入 seam（`deps.platform` / `deps.chromiumCacheRoot` / `execImpl`）直接复用，单测零基建成本。
- **installHost（`:280-331`）**：
  1. CLI 全局安装：`npm i -g` 在 Windows 是用户级（`%APPDATA%\npm`），无需管理员——保留，但 **exec 需 shim 适配**：win32 下对 npm/playwright-cli/npx 类命令走 shell 化执行（`spawnSync(cmd, args, { shell: true })` 或统一 `cmd.exe /c` 包装；命令表固定、无空格参数，安全）。chrome.exe 是真 `.exe`，维持 execFile。
  2. 系统 Chrome：新增 winget 尝试（`winget install --id Google.Chrome -e --silent --accept-package-agreements --accept-source-agreements`，存在 winget 才试，失败静默降级），不引入 deb/apt 的 Windows 等价物。注：`Google.Chrome` 默认 machine scope，可能触发 UAC 提权弹窗——后端是用户态进程，弹窗被拒即非零退出走 chromium 降级（已有），无人值守场景须接受偶发提权框，后续可评估 `--scope user`。
  3. chromium 兜底：`playwright-cli install-browser` + `PLAYWRIGHT_DOWNLOAD_HOST`（npmmirror）**本来就跨平台**，当前链路在 Windows 已能下载成功——修好检测后此步即通。
- **状态机/单飞/孤儿处理/ensureForSkills 钩子**：零改动（与平台无关）。

### D3 sidecar：预期零改动

`browser-live-host.mjs` 全部为跨平台 API：`fs.watch`/轮询扫端口文件、CDP WS（Node 22 全局 WebSocket）、`127.0.0.1` SSE server、`process.kill(pid, 0)` 存活探测、pid 归属检查清理文件、**纯观察者**（killBrowserEntry 只断接入 + 删端口文件 + 发 stopped，从不杀浏览器进程）。浏览器生命周期由 CLI 守护进程持有，Windows 下同样成立。唯一要真机确认的点：`fs.watch` 对扁平目录单文件重建的事件可达性（已有 2s 轮询兜底，不阻塞）。

### D4 shell 生命周期语义差异（记录性决策，不改代码）

| 事件 | POSIX（现状） | Windows（预期） |
|---|---|---|
| shell 工具回收（每条命令后 `keep_session=false` 回收宿主，`localShell.cjs:688-689`） | `kill(-pid, SIGKILL)` 整组；CLI 守护进程自成进程组逃逸 → 浏览器存活 | `taskkill /PID x /T /F` 树杀（`localShell.cjs:342-353`）。**回收时 wrapper / CLI 前端已退出**，daemon / chrome / sidecar 的 PPID 悬空（Windows 孤儿不重新挂父），树杀向下遍历不可达 → **与 POSIX 一样逃逸存活**；只有「命令执行中取消」的竞态窗口树杀可达（此时 daemon/chrome/sidecar 会被一并击杀） |
| sidecar | detached spawn 逃逸组杀 | **Windows 无进程组逃逸**：`detached` 只解决控制台窗口与宿主退出不阻塞，不断开 PPID；存活机制与上一行同（回收时树杀不可达）。竞态窗口被杀也不阻塞——下条命令的 `host_alive` 检查自动重启 sidecar 续播 |
| 浏览器被杀后 | sidecar CDP 探测 → `browser_exit` 收窗 | 同左（探测逻辑跨平台） |
| 孤儿兜底 | 每条命令确保 sidecar 存活 + 端口探活重挑 + POST /stop + Electron before-quit shutdown | 同左 |

即 **Windows 与 POSIX 的回收语义同构**：命令完成后的常规回收两端都杀不到逃逸进程，浏览器回收同样依赖 /stop 链路 + before-quit shutdown + sidecar 2h 硬上限；唯一差异是「命令执行中取消」窗口——Windows 树杀更彻底（连 sidecar 一起杀，直播中断由续播兜底），POSIX 组杀仍杀不到。此前「会话结束浏览器随 taskkill 一并退出、无孤儿 Chrome」的预期**不成立**，回收不靠树杀。真机重点确认：命令执行中取消的树杀覆盖深度（daemon/chrome 是否被及）与竞态窗口大小。

### D5 SKILL.md 平台适配

- **入口分流**：`Skill path` 章节增加探测指引——`node -e "console.log(process.platform)"`（两壳通用）；`win32` → 所有示例用 `node "<技能目录>/scripts/browser_cli.mjs" …`；否则维持 `PWCLI=browser_cli.sh` 示例。M2 统一后删除分流段。
- **shell 语法**：Windows 段示例遵守 PowerShell 5.1（`powershell.exe` 宿主）：不用 `&&`（用 `;` 或分行）、不写 `$(…)>/dev/null` 类 bash-ism；环境变量 `MAO_BASE_URL/MAO_TOKEN/PWCLI_PACKAGE` 的设置示例给 PowerShell 写法（`$env:X="…"`）。
- **前置检查**：统一为 `node --version` + `npm --version`（两壳通用），替代 bash 的 `command -v npx`。
- **环境适配章节**：补 LOCAL/Windows 口径——内核可能未预装，首次 `open` 报缺内核时引导「管理后台 → Skills 管理 → 安装依赖」（wrapper stderr 提示文案已有，两边共用）。注意拓扑差异：该引导只在「后端与桌面同机」时指向用户机；连远程 Linux 后端时「安装依赖」装到的是服务器而非用户机——workflows.md 排障表 Windows 段须写清此差异，远程后端形态的口径是「装系统 Chrome 或在用户机执行 `npx playwright-cli install-browser`」。

### D6 本地技能装载链路确认（无需改动的结论性事实）

LOCAL 技能经 `/v1/skills/sync-package` zip 下发、Electron `localSkills.cjs` 解包为**真实目录**（`extractSkillZip`），不产生 Windows symlink 权限问题；PromptEngine 读文件与 wrapper `SKILL_DIR/../..` 推导在真目录下成立。后端侧 `skill-sync-service.ts` 的 `symlinkSync('dir')` 仅服务 CLOUD 服务端 runtime（Linux），不落在 Windows 机器上。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `skills/bundled/browser-use/scripts/browser_cli.mjs`（新增） | node 单文件入口（D1 全部职责 + Windows shim spawn 策略）；纯 POSIX 时行为与 bash 版等价 |
| `skills/bundled/browser-use/scripts/browser_cli.sh` | M1 不动；文件头注释加「Windows 请用 browser_cli.mjs」；M2 删除 |
| `skills/bundled/browser-use/SKILL.md` | D5：平台分流 + PowerShell 语法段 + 统一前置检查 |
| `skills/bundled/browser-use/references/workflows.md` | 排障表补 Windows 段（内核缺失提示、shim 报错对照） |
| `backend-ts/src/browser-deps/browser-deps.service.ts` | D2：detectChrome win32 候选 + 缓存根平台化 + installHost win32 分支（winget 尝试 + shim exec 适配） |
| `backend-ts/src/browser-deps/browser-deps.service.spec.ts` | platform='win32' 注入用例：检测命中 chrome.exe / chromium 缓存、winget 失败降级 chromium、shim exec 走 shell 化路径 |
| `desktop/electron/*` | 预期零改动（PiP/SSE/live.json 发现均跨平台）；如真机 smoke 暴露 Windows 特有问题在此列补条目 |
| `docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md` | §2 边界行「LOCAL Windows 不支持」改为指向本文档 |
| `DEPLOY.md` / `skills/mao-cli/reference/deploy.md` | 无需改（Windows LOCAL 是用户机侧，不涉服务端部署）；如评审要求补 LOCAL 用户说明再补 |
| `changelog/unreleased/2026-11-xx-browser-use-windows-local.md` | 前端（桌面 / Web / 安卓）+ 后端小节 |

## 5. 测试与验证

1. **单测**（进 CI）：
   - backend vitest：`browser-deps.service.spec.ts` win32 注入用例（D2 三条）；
   - `browser_cli.mjs` 纯函数拆出 `browser_cli_lib.mjs`（argv 解析 / config 组装 / 平台判定），`node --test scripts/*.test.mjs` 本地跑通。勘误：现状对 skills 无任何校验（ci.yml 仅 backend/admin/desktop/agent-cli 四 job，仓库亦无 `bash -n` / `node --check` 脚本）——这两项属本次**新增**的本地检查，是否进 CI 随 M2 一并评估。
2. **构建**：`cd backend-ts && npm test` 全量；`cd desktop && npm run build`（vue-tsc -b 口径）确认桌面零改动无回归。
3. **真机 smoke（Windows 10/11，验收主体）**：
   - ① 全新机器启用 browser-use 技能 → LOCAL 后端自动安装链：CLI 全局装 + chromium 落 `%LOCALAPPDATA%\ms-playwright` → 管理后台状态 ready（kind=chromium）；
   - ② Agent 会话：`node browser_cli.mjs open <url>` → snapshot/click/type/close 全流程 ref 正常；
   - ③ 观看：PiP 出窗、双击放大 Tab、Tab 内停止（主进程 POST /stop）、`browser_live_started/stopped` 事件时序正确；
   - ④ 回收（按 D4 两分支验收）：空闲期会话取消 → chrome/守护进程/sidecar 因 PPID 悬空逃逸存活（树杀不可达），验下条命令端口探活重挑正常；命令执行中取消 → taskkill 树杀可达（真机确认覆盖深度），sidecar 被杀后下条命令自动续播；应用退出 → before-quit shutdown 无孤儿 sidecar；
   - ⑤ 降级：Node < 22 → 直播静默降级、CLI 照常（可选）；无 winget 机器 → chromium 直下；
   - ⑥ 首次运行 SmartScreen/杀毒拦截观察（风险项，见 §6）。
4. **POSIX 回归**：macOS 上 bash wrapper 路径原样跑通（M1 验收项——SKILL.md 分流后 POSIX 流量仍走 bash）。

## 6. 风险与分期

风险：

| 风险 | 缓解 |
|---|---|
| 树杀回收口径（D4）：命令完成后的回收杀不到孤儿浏览器，仅「执行中取消」窗口可达 | 与 POSIX 同构的三层兜底：下条命令端口探活重挑 + POST /stop + before-quit shutdown；真机按 smoke ④ 两分支定级 |
| 无 winget / winget 源不可达 | chromium 兜底本来就通，winget 只是「系统 Chrome 优先」的增益路径 |
| winget 装 Chrome 触发 UAC 提权弹窗（machine scope） | 弹窗被拒 → 非零退出 → chromium 降级已覆盖；无人值守接受偶发提权框，后续评估 `--scope user` |
| `npm prefix -g` 非官方 node 布局下定位失败 | 兜底链降级：npx-cli.js 直 spawn → npx shell:true（全参数加引号）；smoke ③ 覆盖 |
| SmartScreen / 杀软拦 node 子进程或 CDP 端口 | 127.0.0.1 绑定通常无提示；真机观察，文档记录已知 AV 干扰 |
| PowerShell 5.1 引号/编码边角（中文路径、长命令） | localShell 已有 UTF-8 init 与单引号转义协议；SKILL.md 示例规避 bash-ism |
| 双实现窗口期漂移（M1→M2） | M1 期 bash 只加注释；M2 尽快收敛删除 |

分期：

- **M1（本方案）**：`browser_cli.mjs` + SKILL.md 分流 + deps win32 分支 + 真机 smoke。POSIX 零改动。
- **M2（收敛）**：POSIX 切 node 入口、删 bash wrapper、`node --test` 进 CI、SKILL.md 去平台段。前置：M1 真机 smoke + macOS 回归通过。
- **另行立项**：mao-agent Windows 本地执行端、Windows 安装包签名治理。
