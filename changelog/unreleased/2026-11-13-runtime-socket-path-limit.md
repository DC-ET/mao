### 后端

- **修复 runtime channel socket 路径超长时监听失败**：原子替换的 tmp 后缀叠加在 socket 路径上超过 unix socket 路径长度上限（macOS 104 字节）时，内核静默截断 bind 路径，`ensureListening` 必报 rename ENOENT——tmp 后缀缩短为仅带 pid，路径仍超预算时退化为「先移除旧 socket 再直听目标路径」（缺失自愈语义不变；生产 Linux 路径短，原子替换分支不受影响）。
