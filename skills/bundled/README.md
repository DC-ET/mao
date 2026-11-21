# skills/bundled/

本目录下的**每个直接子目录**（含 `SKILL.md`）都会作为「内置技能」随仓库发版进入系统 Skills（技术方案：`docs/plan/2026-11/2026-11-20-builtin-skills-technical-design.md`）。

- 子目录里必须有合法的 `SKILL.md`（YAML frontmatter 的 `name` / `description`），frontmatter `name` 即技能身份，内置技能之间不得重名。
- 目录名与 frontmatter `name` 可以不同，但建议保持一致。
- 不要把 `mao-cli` 复制到这里：它已由 `skills/builtin.json` 白名单点名，住在 `skills/mao-cli/`（文档站、CLI、技能正文共用同一份），复制会造成两处漂移。
- 没有第二用途的定制技能放这里即可，**无需改白名单**。
- 目录内不要执行 `npm install` / 不要提交 `node_modules`：技能视图会把整个目录拷给每个用户的会话副本。

当前已内置：`browser-use/`——playwright-cli 浏览器自动化 + 画面直播（技术方案：`docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`；CLOUD 服务器需预装系统 Chrome 与全局 `@playwright/cli`，见 `skills/mao-cli/reference/deploy.md`）。
