---
name: "browser-use"
description: "Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via `playwright-cli` or the bundled wrapper script. Browser frames are live-streamed to the user's desktop client automatically."
---


# Browser Use Skill

Drive a real browser from the terminal using `playwright-cli`, through this skill's wrapper. The wrapper behaves exactly like the upstream playwright skill's wrapper, and additionally live-streams the controlled pages to the user's desktop client (picture-in-picture) — you do nothing extra for the streaming.
Treat this skill as CLI-first automation. Do not pivot to `@playwright/test` unless the user explicitly asks for test files.

## Prerequisite check (required)

Before proposing commands, check whether `npx` is available (the wrapper depends on it):

```bash
command -v npx >/dev/null 2>&1
```

If it is not available, pause and ask the user to install Node.js/npm (which provides `npx`). Provide these steps verbatim:

```bash
# Verify Node/npm are installed
node --version
npm --version

# If missing, install Node.js/npm, then:
npm install -g @playwright/cli@latest
playwright-cli --help
```

Once `npx` is present, proceed with the wrapper script. A global install of `playwright-cli` is optional.

## Skill path (set once)

技能以**会话级副本**形式加载，路径见系统提示词给出的技能目录，形如
`/opt/mao-data/runtime/<uid>/<sid>/skills/browser-use`。把 `PWCLI` 指向该副本里的 wrapper：

```bash
export PWCLI="<技能目录>/scripts/browser_cli.sh"
```

脚本通过 `BASH_SOURCE` 定位自带的配置模板，在任何路径下都能正常工作。后续所有示例中的
`"$PWCLI"` 都指这个 wrapper。

## 环境适配（本环境必读）

1. **浏览器内核：本环境已预装系统 Chrome，开箱即用，无需任何安装。** CLI 用的是 `chrome`
   channel。所以：

   - **不要**执行 `npx playwright install` / `install chromium` / `install chrome`。
     下载源慢且 chromium 整套 600MB+ 根本装不完，还会与并发会话争抢锁文件。
   - 想确认内核可用，跑一次 `"$PWCLI" open <url>` + `"$PWCLI" snapshot`，能取到 ref 即可。
   - 只有真报了 `Chromium distribution 'chrome' is not found`（换机器或被卸载）才需要处理，
     见 `references/workflows.md`。

2. **root 用户的 sandbox**：以 root 运行时 Chromium 会拒绝启动
   （`Running as root without --no-sandbox is not supported`）。wrapper 会在 root 下为你生成的
   `open` config 自动注入 `--no-sandbox`。

3. **不要传自定义 `--config`**：wrapper 为 `open` 生成的 config 承载着画面直播所需的调试端口；
   传自定义 `--config` 会让本次浏览器实例无法直播（自动化本身不受影响）。默认参数已经调好，
   直接用即可。

因此**优先使用 `"$PWCLI"`**，不要直接调用裸 `playwright-cli`。完整排障步骤与错误对照表见
`references/workflows.md`。

## Quick start

Use the wrapper script:

```bash
"$PWCLI" open https://playwright.dev
"$PWCLI" snapshot
"$PWCLI" click e15
"$PWCLI" type "Playwright"
"$PWCLI" press Enter
"$PWCLI" screenshot
```

默认无头启动即可——用户在桌面客户端的画中画窗口里实时看到页面，不需要 `--headed` 抢占真窗口。

## 浏览器直播（画中画）——你无需做任何事，但请注意这些约定

- wrapper 会自动把受控页面的画面实时推给用户的桌面客户端（画中画小窗，可双击放大）。
  这条链路对命令用法零影响，也**不需要你启动或管理任何后台进程**。
- **页面内容对用户可见**：直播期间登录态、表单内容等页面信息会实时展示给会话属主。
  涉及敏感信息输入时正常操作即可，但不要在对话中复述页面上的敏感凭据。
- 结束时**务必 `"$PWCLI" close`**（见 Guardrails）：这会关闭浏览器，直播窗口随之自动收起。
- 命名会话（`-s=name`）同样支持直播；多个会话并行时用户看到最近活跃的画面。
- 若用户说「看不到画面 / 直播没弹出来」，大概率是本地 Node 版本过低（直播采集需要 Node ≥ 22）
  或桌面客户端未运行——自动化不受影响，无需排查，继续任务即可。

## Core workflow

1. Open the page.
2. Snapshot to get stable element refs.
3. Interact using refs from the latest snapshot.
4. Re-snapshot after navigation or significant DOM changes.
5. Capture artifacts (screenshot, pdf, traces) when useful.

Minimal loop:

```bash
"$PWCLI" open https://example.com
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" snapshot
```

## When to snapshot again

Snapshot again after:

- navigation
- clicking elements that change the UI substantially
- opening/closing modals or menus
- tab switches

Refs can go stale. When a command fails due to a missing ref, snapshot again.

## Recommended patterns

### Form fill and submit

```bash
"$PWCLI" open https://example.com/form
"$PWCLI" snapshot
"$PWCLI" fill e1 "user@example.com"
"$PWCLI" fill e2 "password123"
"$PWCLI" click e3
"$PWCLI" snapshot
```

### Debug a UI flow with traces

```bash
"$PWCLI" open https://example.com
"$PWCLI" tracing-start
# ...interactions...
"$PWCLI" tracing-stop
```

### Multi-tab work

```bash
"$PWCLI" tab-new https://example.com
"$PWCLI" tab-list
"$PWCLI" tab-select 0
"$PWCLI" snapshot
```

## Wrapper script

The wrapper makes the CLI runnable without a global install: when `playwright-cli` is not on
`PATH`, it calls `npx --yes --package @playwright/cli@latest playwright-cli`; as root it injects
`--no-sandbox` into the generated `open` config. Set `PWCLI_PACKAGE` to pin a version.

```bash
"$PWCLI" --help
```

Prefer the wrapper unless the repository already standardizes on a global install.

## References

Open only what you need. In every reference below, a bare `playwright-cli` means the same thing as
this skill's wrapper `"$PWCLI"` — prefer the wrapper so the sandbox and live-streaming handling
described in 「环境适配」 above still applies.

Maintained with this skill:

- CLI command reference: `references/cli.md`
- Practical workflows and troubleshooting: `references/workflows.md`

Bundled with the upstream `@playwright/cli` skill:

- Sessions and state: `references/session-management.md`, `references/storage-state.md`
- Debugging and evidence: `references/tracing.md`, `references/video-recording.md`,
  `references/request-mocking.md`, `references/running-code.md`, `references/element-attributes.md`
- Playwright test files — only when the user explicitly asks for test files, not as a default pivot:
  `references/playwright-tests.md`, `references/test-generation.md`
- Attaching screenshots and videos to pull requests: `references/pr-attachments.md`

## Guardrails

- Always snapshot before referencing element ids like `e12`.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over `eval` and `run-code` unless needed.
- When you do not have a fresh snapshot, use placeholder refs like `eX` and say why; do not bypass refs with `run-code`.
- Default to headless (no `--headed`): the user watches via the live picture-in-picture view.
- Always end browser tasks with `"$PWCLI" close` (or `close-all` when you used named sessions) — this tears down the browser and the live view.
- Artifacts default to `./.playwright-cli/` under the current working directory; pass `--filename` when you need a stable name or a project-specific location.
- Default to CLI commands and workflows, not Playwright test specs.
