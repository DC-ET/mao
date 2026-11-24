# skills/bundled/

本目录下的**每个直接子目录**（含 `SKILL.md`）都会作为「内置技能」随仓库发版进入系统 Skills（技术方案：`docs/plan/2026-11/2026-11-20-builtin-skills-technical-design.md`）。

- 子目录里必须有合法的 `SKILL.md`（YAML frontmatter 的 `name` / `description`），frontmatter `name` 即技能身份，内置技能之间不得重名。
- 目录名与 frontmatter `name` 可以不同，但建议保持一致。
- 不要把 `mao-cli` 复制到这里：它已由 `skills/builtin.json` 白名单点名，住在 `skills/mao-cli/`（文档站、CLI、技能正文共用同一份），复制会造成两处漂移。
- 没有第二用途的定制技能放这里即可，**无需改白名单**。
- 目录内不要执行 `npm install` / 不要提交 `node_modules`：技能视图会把整个目录拷给每个用户的会话副本。

当前已内置：`browser-use/`——playwright-cli 浏览器自动化 + 画面直播（技术方案：`docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`；CLOUD 服务器的 Chrome 与全局 `@playwright/cli` 可预装，也可按需自动安装，状态见管理后台 Skills 页「运行依赖」列，详见 `skills/mao-cli/reference/deploy.md`）。

需要服务器侧依赖（二进制或平台配置）的内置技能，按 `docs/plan/2026-11/2026-11-23-skill-runtime-deps-technical-design.md` §9 在 `backend-ts/src/skill-deps/providers/` 注册 provider，管理后台无需改动。
