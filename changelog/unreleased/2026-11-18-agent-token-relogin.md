### 终端 CLI（mao-agent）

- **登录过期时直接询问用户名密码**：交互终端里 access token 和 refresh token 都失效，或还没有登录态时，不再只打印「Token 已过期」后退出，而是提示重新登录并询问用户名和密码，成功后继续刚才的命令。非交互场景和 `--token` / `MAO_TOKEN` 仍只报错。
