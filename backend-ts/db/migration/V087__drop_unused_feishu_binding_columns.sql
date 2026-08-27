-- 删除从未写入的死列 open_id / user_id_fs：
-- 私聊发送目标身份形态已由 feishu_chat.chat_id 前缀（p2p:union:/p2p:open:）在建会话时确定，
-- 绑定表不再需要冗余身份列。
ALTER TABLE `feishu_binding` DROP COLUMN `open_id`;
ALTER TABLE `feishu_binding` DROP COLUMN `user_id_fs`;
