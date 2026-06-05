ALTER TABLE `session` ADD COLUMN `unread` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '后台完成未读标记：0=已读，1=未读';
