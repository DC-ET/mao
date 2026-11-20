# 邮件通知渠道（EMAIL）代码审查报告

- 审查对象：`cd94d241`（feat: 新增邮件通知渠道（EMAIL））相对父提交 `6780abd6` 的全部改动
- 审查范围：仅功能逻辑代码；CHANGELOG.md / DEPLOY.md / skills/ 文档改动按约定跳过
- 审查日期：2026-10-20
- 结论：**发现 1 个阻断级 bug（后端构建失败）**；其余功能逻辑（偏好 EMAIL 分支、设置校验、邮箱变更钩子、微信降级白名单、迁移默认值、前端门禁）经验证正确

---

## Bug 1（阻断）：email-sender.ts transport 工厂入参类型错误，`npm run build` 编译失败

**文件:行号**：`backend-ts/src/notification/task/email-sender.ts:86`（`resolveTransport` 内调用 `this.transportFactory({...})`）

**问题**：

```ts
const transport = this.transportFactory({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.useTls,
  auth,
  connectionTimeout: SOCKET_TIMEOUT_MS,
  greetingTimeout: SOCKET_TIMEOUT_MS,
  socketTimeout: SOCKET_TIMEOUT_MS,
});
```

`TransportFactory` 声明为 `(options: TransportOptions) => Transporter`，其中 `TransportOptions` 从 `nodemailer` 根导入。但在本提交引入的 `@types/nodemailer@^7.0.12` 中，根级别的 `TransportOptions` 只是 `{ component?: string }`（并非各 transport 选项的联合），SMTP 专属选项类型是 `nodemailer/lib/smtp-transport` 里的 `SMTPTransport.Options`。因此对象字面量中的 `host` 触发 TS  excess-property 报错：

```
src/notification/task/email-sender.ts(86,7): error TS2353: Object literal may only specify known properties,
and 'host' does not exist in type 'TransportOptions'.
```

**影响**：`cd backend-ts && npm run build` 退出码 2，后端无法编译。按仓库 AGENTS.md，CI 跑 backend-ts build+test、部署脚本依赖构建产物，此提交直接卡死构建链路。之所以在提交时漏掉：`npm test`（vitest）不做类型检查，且 spec 文件被 `tsconfig.build.json` 排除，单测全绿掩盖了编译失败。

**验证方式**：

```bash
cd backend-ts && npm ci && npm run build
# exit=2，且仅此一条 TS2353（email-sender.ts:86）
```

同时确认该错误只此一处（修复后即可编译）；运行 `npx vitest run --no-coverage src/notification/task/ src/settings/... src/user/... src/weixin/` 共 37 个 spec 文件 420 个用例全部通过，说明这是纯类型层面问题、运行时不依赖该注解。

**修复方向（仅供作者参考，本审查不改代码）**：把工厂入参类型改为 SMTP 专属选项类型，例如
`import type { Options as SmtpTransportOptions } from 'nodemailer/lib/smtp-transport'`，令 `TransportFactory = (options: SmtpTransportOptions) => Transporter`；
或去掉显式 `TransportOptions` 注解、直接以内联对象调用并依赖 `createTransport` 重载推断。注意 spec 中 `options[0].connectionTimeout` 等访问同样依赖更宽的类型，修复时需一并保证 spec 仍可通过现有构建排除规则（spec 不进 tsc，但建议顺手核对）。

---

## 已验证正确的部分（未发现 bug）

以下各项均通过代码走查 + 运行现有/新增测试确认：

1. **偏好服务 EMAIL 分支**（`preference.service.ts`）：保存时地址只取用户表 email 且每次重算密文（不继承旧密文）；无邮箱 / SMTP 未启用时拒绝并给出邮箱口径文案；`get` 对 EMAIL 返回 `maskEmail` 而非 URL 掩码；`sendTest` 忽略入参 webhookUrl、优先已存密文、无偏好回落资料邮箱；`refreshEmailAddress` 对非 EMAIL 渠道 no-op、清空邮箱时清空密文（`findEnabled` 自然跳过投递）、失败只 warn。既有 DINGTALK/FEISHU 规则（切渠道必须填新地址）无回归。
2. **设置域**（`settings.service.ts` / `settings.routes.ts` / `settings-test.service.ts`）：`getEmailSmtpConfig` 缺行回落与 V161 seed 默认值一致（端口 465 / 隐式 TLS / 关闭）；单 key 与 batch 两条路径共用组校验（enabled=1 时 host/port/fromAddr 必填合法），batch 内 enabled 与 host 同批保存顺序无关；密码行 is_secret 加密存储、掩码回显、空串清除语义正确；`POST /v1/system-settings/test/smtp` overrides 合并（留空回落已存）、enabled 强制置 true、发信到管理员本人邮箱、无邮箱/格式错/端口越界均拒绝。
3. **邮箱变更钩子**（`user.service.ts` + `create-app.ts`）：自助路径仅在邮箱实际变化时触发；管理端路径补了 EMAIL_PATTERN 校验（非法地址拒绝、不进密文）；`email != null` 占位语义正确（null=不修改）；未注入监听器时兼容既有装配；create-app 中闭包延迟绑定 `notifPref` 无 TDZ 风险（仅请求期调用）。
4. **微信降级白名单**（`webhook-fallback.service.ts`）：放行 EMAIL 后 DINGTALK/FEISHU 行为不变；EMAIL 时 card 被 sender 忽略、text 含降级头；发送失败返回 false 不抛错。
5. **V161 迁移**：7 行 seed 与代码读取口径一致（enabled '0'、port '465'、secure '1'、密码行随后 `UPDATE ... SET is_secret=1`，V093 同款句式）；`system_setting.is_secret` 列自 V093 起存在；迁移编号 161 为当前最新无冲突。
6. **契约放宽**：`NotificationChannel` 加 `'EMAIL'` 后全仓无 `Record<渠道,…>` 穷尽映射（消费方仅 parse / Map 注册表 / 桌面选项数组），无编译连锁反应；desktop/admin `vue-tsc -b --force` 均通过。
7. **前端门禁**：desktop `canSave`/`canTest`/`hasUsableWebhook`/`validateWebhook` 对 EMAIL 旁路（可用性=资料邮箱非空）；保存/测试不传 webhookUrl；admin SMTP 卡片含测试连接按钮（密码未重填时走后端已存值合并，不会误用掩码）；`notify.email.smtpPort` 走数字输入、`smtpSecure` 走开关且 `isSwitchOn` 兼容 0/1 与 true/false。
8. **投递链路**：调度器对 EMAIL 零改动即可工作（解密密文即收件地址、重试/终态/WS 抑制/metrics 同口径）；配置缺失时返回不可重试失败，1 次尝试即终态，不会无谓重试 20 分钟。

---

## 测试运行记录

| 范围 | 命令 | 结果 |
|---|---|---|
| 本次触及的后端 spec（notification/task 全部 + settings-test/settings.service/user.service/weixin） | `cd backend-ts && MAO_TEST_TMP_DIR=/tmp/mtest npx vitest run --no-coverage <上述目录>` | 37 files / 420 tests 全过 |
| 后端全量 | `cd backend-ts && MAO_TEST_TMP_DIR=/tmp/mtest npm test` | 4357 例中 6 例失败，均为 `harness/container`、`harness/safety`、`generate-image-tool` 的路径沙箱用例；已在父提交 6780abd6 上复现同样失败，属本机环境问题，与本提交无关 |
| 后端构建 | `cd backend-ts && npm run build` | **exit=2（Bug 1）** |
| desktop 类型检查 | `cd desktop && npx vue-tsc -b --force` | 通过 |
| admin 类型检查 | `cd admin && npx vue-tsc -b --force` | 通过 |
| 新增桌面 e2e（邮件渠道） | `npx playwright test --config=tests/playwright.config.ts desktop.spec.ts -g "email channel"` | 1 passed（隐藏 webhook 输入、展示收件邮箱、不带 webhookUrl 测试与保存均符合预期） |
| admin 设置 e2e | `npx playwright test --config=tests/playwright.config.ts admin-settings-cards.spec.ts admin-settings-integration.spec.ts`（需 `MAO_ADMIN_PASS=admin123`） | 3 例失败，均与本提交无关（见下方说明） |

> 备注：审查过程中本机 worktree 的 `backend-ts/node_modules` symlink 一度被误删，已用 `npm ci` 按提交内 package-lock.json 原样恢复（lock 文件未改动，`git status` 干净）。

**关于 admin 设置 e2e 3 例失败的归属认定**（均非本提交引入；失败断言指向的配置项都不在本提交改动面内）：

1. `plain categories render as card forms`：断言「运行环境」只读分类无保存按钮，实际有 1 个。原因是 `runtime.mode` 设置行（V160，category='运行环境'，editable=1）——V160 由祖先提交 `a511b05a` 引入（已用 `git merge-base --is-ancestor` 核实早于父提交 6780abd6），该 e2e 断言相对 V160 已过时。
2. `settings integration panel renders with masked secrets and feishu test passes`：断言飞书 appSecret 密码框 placeholder 为「已设置」，实际为空——e2e 种子库未种该 secret；本提交不触碰飞书 OAuth 配置。
3. `settings batch save round-trip persists and restores value`：断言 `oss.region` 输入值含 `oss-cn-`，实际为空——e2e 种子库未种 OSS 配置；本提交不触碰 OSS 配置。

本提交对 admin 设置页的唯一改动是新增「通知与消息」分类下的邮件（SMTP）卡片组与测试连接按钮；新增的桌面邮件渠道 e2e（`desktop.spec.ts` 邮件用例）实跑通过。
