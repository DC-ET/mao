### 后端

- **发出的附件改为发送时留快照，删改源文件不再让已发附件失效**：`send_image` / `send_file` 发送工作区文件时，发送那一刻会另存一份快照（本地 `FILE_SEND_DIR/{userId}/{uuid}{ext}`，对象存储则 PUT 到私有前缀 `send-files/`），消息里只记快照 id，对话页经带属主鉴权的 `GET /v1/files/send-download` 取字节。此前消息记的是公开 `/uploads/` 下的副本地址或工作区实时路径，Agent 收尾清理、用户改名或删除源文件都会让已经发出去的附件打不开。发送 Agent 自己 `uploads/` 目录里的既有产物（如文生图结果）仍直接引用，行为不变。云模式新增 `GET` 预签名供服务端代读，云地址与 token 都不会进消息 JSON。
- **`FILE_SEND_DIR` 缺省值改为上传目录的兄弟目录**：不再默认后端进程 cwd 下的 `./send-files`（改大了 `FILE_UPLOAD_DIR` 却忘了改它时，快照会落到另一块文件系统、不在受备份的数据根里）。未显式设置时取 `{FILE_UPLOAD_DIR 的父目录}/send-files`，生产即 `/opt/mao-data/send-files`；显式设置仍以环境变量为准，配在 `FILE_UPLOAD_DIR` 之内启动即拒（符号链接与大小写别名同样拒）。
- **修复文件名含反斜杠时下载头的引号被吃掉**：`Content-Disposition` 的 ASCII 兜底段此前只转义 `"`，反斜杠是可打印字符、能活过过滤，于是 `report\` 这类名字会拼出 `filename="report\"` 这种不闭合的 quoted-string，部分下载器存下畸形文件名。`send_file` 的文件名由模型给出，这条从理论缺陷变成可稳定触达。

### 前端（桌面 / Web / 安卓）

- **新发送的附件卡片改走快照取数**：附件卡片、图片网格与下载按钮按快照 id 拼 `send-download` 地址（渲染期才追加登录 token），同一轮发多个附件各自独立，不再共用同一个 key 导致重复加载。历史消息里的旧地址与旧工作区引用照常可看。

### Embed SDK

- **嵌入浮窗的附件卡片同步按发送快照取数**：浮窗里的 `send_image` / `send_file` 快照按快照 id 拼 `send-download`（渲染期才追加登录 token），同一轮多个附件各自独立。补交与当前 SDK 源码一致的 `mao-chat.js` 与 `mao-chat.v0.3.4.js`。

### 管理后台

- **智能体头像上传地址带上用户目录段**：头像上传落在 `uploads/{userId}/` 后，返回的 `/uploads/{uuid}.png` 旧格式地址一律按 `uploads/{数字用户 id}/{uuid}.png` 接受，存量头像不受影响。
