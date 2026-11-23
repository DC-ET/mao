### 管理后台

- **修复 docker 运行时下 browser-use 依赖误报「依赖未安装」**：此前 Skills 管理页的状态只探测宿主机，容器镜像里的 Chrome / playwright-cli 不算数，导致镜像明明已内置依赖仍显示未安装、并给出生效于镜像重建的「安装依赖」按钮。现在 docker 模式改以镜像内容为准（一次性容器探测），镜像已就绪直接显示「依赖就绪」；点「安装依赖」也只会在镜像确实缺依赖时才触发重建。

### 后端

- **浏览器依赖 docker 模式探测**：`GET /admin/browser-deps/status` 在 docker 运行时用 `docker run --rm --network none` 探测镜像内 Chrome 与 playwright-cli，镜像就绪时状态恒为 ready（不再被宿主机探测打回），探测不可用时保留存量状态；`POST /admin/browser-deps/install` 与 Agent 勾选触发的 ensure 在依赖已就绪时直接返回（`started:false`），不再无谓重建运行时镜像。
