### 后端

- **修复 systemd 部署后后端随部署服务退出被误杀**：蓝绿启动的新实例改为独立 transient unit（`Restart=no`），不再继承部署命令所在 systemd 服务的 cgroup；无 systemd 环境仍回退 `setsid nohup`。
