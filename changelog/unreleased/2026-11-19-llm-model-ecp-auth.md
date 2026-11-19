### 后端

- **模型凭证方式新增「当前用户 ECP Token」**：模型配置支持两种凭证方式（单选）——固定 API Key（默认，行为不变）与「当前用户 ECP Token」。选择后者时，每次 LLM 调用实时解析**触发本次任务的用户**（会话归属/群聊发言者）的 ECP 登录凭证作为 Bearer，不再使用模型上的固定 Key；库表 `llm_model.auth_type`（迁移 V198，存量行默认 `api_key`）。适用范围为接受 ECP Bearer 的内部网关。用户未完成 ECP 飞书登录时返回明确引导文案；ECP 开关关闭或无有效凭证时直接报错，**绝不静默回退固定 Key**。连通性测试使用发起测试的管理员本人凭证；微信语音合成使用绑定账号的归属用户身份。

### 管理后台

- **模型编辑弹窗新增「凭证方式」单选**：固定 API Key / 当前用户的 ECP Token。ECP 选项仅在系统配置「启用 ECP 飞书登录」打开时可选；ECP 模式无需填写且不校验 API Key（原 Key 保留在库中，切回「固定 API Key」即可继续使用）。模型列表对 ECP 模型显示 `ECP` 标签。

### 终端 CLI（mao-cli）

- **`mao model create/update` 支持 `--auth-type api_key|ecp`**：`ecp` 模式下 `--api-key` 可省略（要求系统已启用 ECP 飞书登录）。
