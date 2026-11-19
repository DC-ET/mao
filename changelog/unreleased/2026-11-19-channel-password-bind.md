### 后端

- **飞书 / 钉钉通道新增「账号密码登录绑定」**：未开通对应 IM 登录（飞书 OAuth / ECP、钉钉 OAuth）但账号密码登录开启、`site.baseUrl` 可用的部署里，未绑定发送者收到的引导卡改为「登录 Mao 并绑定」，链接指向 Web 绑定确认页（15 分钟有效、单次使用），登录后核对双方身份并点一次「确认绑定」即完成绑定并补投原消息；确认步不做全自动、不提供开关。绑定优先级不变：飞书 ECP > 飞书 OAuth > 密码绑定 > 文本回退；钉钉 OAuth > 密码绑定 > 文本回退。已开通各通道 OAuth/ECP 的部署行为不变。
- 新增通道无关绑定编排 `channel-bind/bind-flow`（原 ECP 专用编排泛化迁入，ECP 回调行为不变），新增 JWT 保护接口 `GET /v1/feishu/binding/pending`、`POST /v1/feishu/binding/complete`、`GET /v1/dingtalk/binding/pending`、`POST /v1/dingtalk/binding/complete`（预览返回双方身份与改绑提示；complete 按成功 / 未完全成功 / 未完成三档返回）。无新表、无迁移。

### 前端（桌面 / Web / 安卓）

- 新增通道绑定确认页（Web SPA 路由 `/feishu/bind/:state`、`/dingtalk/bind-pwd/:state`）：未登录自动跳登录页并回跳；确认卡展示「IM 用户 → Mao 账号」双方身份、会话类型、有效期与改绑提示，点「确认绑定」后才发起绑定，取消不消费链接；结果页按成功 / 未完全成功 / 未完成三档渲染并提示回 IM 查看会话。
