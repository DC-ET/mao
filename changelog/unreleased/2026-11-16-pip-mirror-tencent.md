### 后端

- **修复容器内 pip 装大包慢到像卡住**：镜像内置的 aliyun PyPI 源对本环境 HTTP/1.1 连接限速约 200KB/s（同域名 HTTP/2 可达 30MB/s+，但 pip 不支持 HTTP/2），pandas / matplotlib 这类大包安装要十几分钟，工具调用反复「等待超时」；依赖环境（`buildDepsEnv`）现在注入 `PIP_INDEX_URL` 指向腾讯云 PyPI 镜像（env 优先于 `/etc/pip.conf`，实测完整安装 pandas+matplotlib 14 秒），对存量容器即时生效、用户自定义 `PIP_INDEX_URL` 仍可覆盖。镜像定制层（runtime-image-ext）的 pip 源同步更新，随下次镜像重建生效。
