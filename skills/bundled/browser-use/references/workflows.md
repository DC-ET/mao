# 实用工作流与排障

## 标准交互循环

1. `open` 打开页面
2. `snapshot` 取稳定 ref
3. 用最新 snapshot 里的 ref 交互
4. 导航或 DOM 大改后**重新 snapshot**
5. 需要时留下产物（screenshot / pdf / trace）

```bash
"$PWCLI" open https://example.com
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" snapshot
```

必须重新 snapshot 的时机：发生导航、点击后 UI 大幅变化、开合弹窗或菜单、切换标签页。
ref 会过期，命令因为找不到 ref 失败时，重取 snapshot 再试。

## 表单填写与提交

```bash
"$PWCLI" open https://example.com/form
"$PWCLI" snapshot
"$PWCLI" fill e1 "user@example.com"
"$PWCLI" fill e2 "password123"
"$PWCLI" click e3
"$PWCLI" snapshot
```

`fill` 直接设值，`type` 是逐键输入（会触发按键相关逻辑）。填完要回车可以加 `--submit`。
提交后务必再 snapshot 一次，确认是成功页还是校验错误，不要凭点击成功就断言流程通过。

## 多标签

```bash
"$PWCLI" open https://example.com
"$PWCLI" tab-new https://example.com/other
"$PWCLI" tab-list
"$PWCLI" tab-select 0
"$PWCLI" snapshot
```

`tab-select` 之后必须重新 snapshot，不同标签的 ref 不通用。

## 用 trace 调 UI 流程

```bash
"$PWCLI" open https://example.com --headed
"$PWCLI" tracing-start
# ...交互...
"$PWCLI" tracing-stop
```

排查「为什么这个点击没生效」时，`console` 和 `requests` 通常比反复看 snapshot 更快：

```bash
"$PWCLI" console            # 有没有 JS 报错
"$PWCLI" requests           # 提交请求发出去了吗、返回什么
"$PWCLI" request 5
```

## 复用登录态

不要每次重新走登录流程，先存一次状态：

```bash
"$PWCLI" open https://app.example.com/login
"$PWCLI" snapshot
"$PWCLI" fill e1 "user@example.com"
"$PWCLI" fill e2 "password123"
"$PWCLI" click e3
"$PWCLI" snapshot
"$PWCLI" state-save auth.json
```

后续：

```bash
"$PWCLI" open https://app.example.com
"$PWCLI" state-load auth.json
"$PWCLI" goto https://app.example.com/dashboard
```

多任务并行时用命名会话隔离，避免互相踩 cookie：

```bash
"$PWCLI" -s=auth open https://app.example.com/login
"$PWCLI" -s=public open https://example.com
```

## 产物路径

截图、snapshot、PDF 默认写到**当前工作目录**下的 `.playwright-cli/`：

```bash
"$PWCLI" --raw snapshot > before.yml
ls .playwright-cli/
```

需要固定文件名或放到项目约定的产物目录时，显式传 `--filename`：

```bash
"$PWCLI" screenshot --filename=settings-after.png
"$PWCLI" pdf --filename=page.pdf
```

`.playwright-cli/` 是运行期产物，不要提交进版本库。

## 环境排障

### Chromium distribution 'chrome' is not found

`playwright-cli` 默认使用 `chrome` channel，而不是自带的 chromium。**本机已预装**系统 Chrome，
正常不会遇到这个错误；遇到时先确认，不要直接上手装 chromium：

```bash
google-chrome --version
command -v google-chrome
```

真的缺失（换机器/被卸载）时，优先装系统包，别走 playwright 的默认 CDN：

```bash
apt-get install -y google-chrome-stable    # 或改用内网源
```

**不要**习惯性执行 `npx playwright install chromium`：本环境默认源仅约 30KB/s，640MB 装不完，
多会话还会因 `~/.cache/ms-playwright/__dirlock` 互锁而失败。确实必须用 playwright 自带内核时，
务必换镜像源并 pin 版本：

```bash
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
  npx --yes playwright@1.61.1 install chromium   # 实测 23s 装完 646MB
```

版本必须对齐：`playwright@1.61.1` 要 `chromium-1228`，`@latest` 要另一个 revision，混用会重复下载。

用 `--browser=firefox` / `webkit` 时，对应内核同样要各自具备。

### @playwright/test（仓库 E2E）与 CLI 不是一回事

`@playwright/test` 默认用自带的 chromium，**不读**本技能和上面的 CLI config。仓库里
`npm test` 之类的 E2E 若报缺浏览器，不要当成 CLI 问题去 `install`，而是在
`playwright.config.ts` 里改用系统 Chrome：

```ts
use: {
  channel: 'chrome',
  launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
}
```

本环境实测：缓存中无任何 chromium 时，`channel: 'chrome'` + `--no-sandbox` 可正常跑通
（`browser.version()` 返回系统 Chrome 版本）。

### Running as root without --no-sandbox is not supported

以 root 运行时 Chromium 直接拒绝启动：

```
[ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102]
Running as root without --no-sandbox is not supported.
```

`playwright-cli open` **没有** `--no-sandbox` 这个选项，只能通过 config 的
`browser.launchOptions.args` 注入。wrapper 已经自动做了这件事（仅在 root + `open`/`attach`
且用户未自行传 `--config` 时生效），所以优先直接用 wrapper。

如果绕过 wrapper 调裸命令，则需要自己准备 config：

```bash
"$PWCLI" open https://example.com --config=/path/to/cli.config.json
```

或在**工作目录**放 `.playwright/cli.config.json`：

```json
{
  "browser": {
    "launchOptions": {
      "channel": "chrome",
      "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    }
  }
}
```

`--disable-dev-shm-usage` 用于容器内 `/dev/shm` 偏小的场景，可避免页面偶发崩溃。

### config 是按工作目录解析的

缺省的 `.playwright/cli.config.json` 相对**当前工作目录**，换个目录跑就失效 —— 这是
「刚才还好好的，换个项目就启动不了」的常见原因。wrapper 注入的是技能目录下的绝对路径
config，因此不受 cwd 影响。

### 浏览器进程残留

会话异常中断后可能留下后台进程，用 `list` 查看、`close-all` 关闭、`kill-all` 强杀。

### npx 首次调用较慢

首次要下载并解析 `@playwright/cli`，之后走本地缓存。需要稳定版本时显式固定：

```bash
PWCLI_PACKAGE=@playwright/cli@1.2.3 "$PWCLI" --version
```

或直接全局安装：`npm install -g @playwright/cli@latest`，wrapper 会优先使用它。

## 常见错误对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `Chromium distribution 'chrome' is not found` | 系统 Chrome 缺失（本机已预装，少见） | 先 `google-chrome --version` 确认；缺则装系统包，**不要**跑 `playwright install chromium` |
| `An active lockfile is found at ... __dirlock` | 同一用户其它会话正在装浏览器 | 别再重试安装；本机无需安装，直接跑 `"$PWCLI" open` |
| `Running as root without --no-sandbox` | root 下缺 sandbox 参数 | 用 wrapper，或补 config 的 `args` |
| `The browser 'default' is not open, please run open first` | 会话未启动或已闲置超时 | 重新 `open` |
| 命令报找不到 ref | ref 过期（导航/DOM 变化） | 重新 `snapshot` |
| 换了目录后启动失败 | config 按 cwd 解析 | 用 wrapper，或在新 cwd 补 config |
| `open` 卡住或页面崩溃 | `/dev/shm` 太小 | config 加 `--disable-dev-shm-usage` |
