-- 网页正文默认输出上限从 500000 下调到 50000 字符（SettingsService 代码默认值已同步）。
-- 仅刷新说明文案；value 保持 NULL 表示"从未设置"，仍由代码默认值兜底。
-- 超出上限时 open_web_page 会截断返回，并把完整正文写入
-- runtime/<userId>/<sessionId>/webPages/ 供 Agent 用 read_file / grep_search 按需回读。
UPDATE `system_setting`
SET `description` = '网页抓取输出字符上限（重启后端后生效，默认 50000；超出即截断，完整正文落盘到会话 runtime 的 webPages 目录可回读）'
WHERE `setting_key` = 'harness.webPage.maxOutputLength';
