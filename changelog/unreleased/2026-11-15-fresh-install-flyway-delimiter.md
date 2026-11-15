### 后端

- **修复从零安装迁移必失败**：`npm run start:dev` 整文件灌给 mysql2 multipleStatements 时，`DELIMITER` 被当作 SQL 发给服务端、存储过程体被 `;` 盲切（V001 即失败，新装环境无法建表）。迁移执行器改为 delimiter-aware 逐句执行（`splitSqlStatements`），与 mysql 客户端同口径，含存储过程的迁移可直跑；行尾归一 LF，Windows checkout（autocrlf）不再影响迁移执行。
- **`start:dev` 自动加载 `backend-ts/.env`**：改用 `tsx --env-file-if-exists=.env`，按 install.md 复制 `.env.example` 后无需手工 export（Node 22+）。

### 终端 CLI（mao-cli）

- **install.md 补从零安装要点**：`APP_GIT_CREDENTIAL_SECRET` 为唯一无内置默认的必填项（生成：`openssl rand -base64 32`）；说明 `.env` 会被 `start:dev` 自动加载。仓库新增 `.gitattributes` 强制 `*.sql`/`*.sh` 为 LF，避免 Windows 克隆把迁移脚本转 CRLF。
