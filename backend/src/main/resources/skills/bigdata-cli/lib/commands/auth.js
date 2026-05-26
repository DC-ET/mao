import {
  clearAuthStore,
  getAccountFilePath,
  getTokenFilePath,
  loginAndPersist,
  refreshToken,
} from "../auth.js";

export async function handleAuthCommand(config, subcommand, values) {
  switch (subcommand) {
    case "login": {
      const username = String(values.username ?? "").trim();
      const password = String(values.password ?? "");
      if (!username || !password) {
        throw new Error("`auth login` 需要 `--username` 和 `--password`。");
      }
      const store = await loginAndPersist(config, username, password);
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              username: store.username,
              accountFile: getAccountFilePath(),
              tokenFile: getTokenFilePath(),
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `登录成功，账号密码已保存到 ${getAccountFilePath()}，token 已保存到 ${getTokenFilePath()}`,
      );
      return;
    }

    case "refresh": {
      await refreshToken(config);
      console.log(values.json ? JSON.stringify({ refreshed: true }, null, 2) : "token 已刷新。");
      return;
    }

    case "logout": {
      await clearAuthStore();
      console.log(values.json ? JSON.stringify({ cleared: true }, null, 2) : "已清除本地凭据与 token 缓存。");
      return;
    }

    default:
      throw new Error(`未知的 auth 子命令: ${subcommand}`);
  }
}
