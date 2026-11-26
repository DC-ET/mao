### 后端

- **文生图模型不再保存聊天协议**：创建或更新 `model_type=image` 时忽略 `apiProtocol` 与 `effort` 并清空。连通性测试改为调用 `/images/generations`（短提示词、低质量），不再打 `/chat/completions`。

### 管理后台

- **文生图接入配置改为展示真实路径**：隐藏「API 协议」，地址后缀固定为 `/images/generations`，并注明改图走 `/images/edits`。列表协议角标改为 OpenAI Images。测试按钮改为「试生成」，成功只展示耗时，失败展示上游错误。
